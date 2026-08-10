/**
 * Save Feeder Calibrations Command Handler
 *
 * Writes a feeder's CAPABILITY and its per-feed calibrations in one transaction.
 * They are one write on purpose: the calibration rows are FK-pinned to the
 * capability row's dosing mode and speed band, so a client that could save them
 * separately could only ever save them into an inconsistent moment. One write
 * means "commissioned but uncalibrated" and "calibrated but uncommissioned" are
 * both unreachable through this API, and the FK makes the latter unreachable
 * through every other writer too.
 *
 * Upsert strategy: replace the calibration set for the equipment, then insert
 * the new one. Uses the canonical tenant transaction/audit/outbox contract so
 * the capability row, the calibration set, the audit row and the event row
 * commit or roll back together.
 */
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { createBaseEvent, type FeederCalibrationsSavedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { SaveFeederCalibrationsCommand } from '../commands/save-feeder-calibrations.command';
import { Equipment } from '../entities/equipment.entity';
import { EquipmentCategory, EquipmentType } from '../entities/equipment-type.entity';
import {
  FeederCapability,
  FeederDispenseControl,
  FeederDosingMode,
} from '../entities/feeder-capability.entity';
import { FeederCalibration } from '../entities/feeder-calibration.entity';

/** The shape both input branches collapse into once the mode is known. */
interface NormalisedCalibration {
  feedId: string;
  gramsPerDispensing?: number;
  gramsPerMinute?: number;
  referenceSpeedHz?: number;
  notes?: string;
}

@CommandHandler(SaveFeederCalibrationsCommand)
export class SaveFeederCalibrationsHandler
  implements ICommandHandler<SaveFeederCalibrationsCommand, FeederCalibration[]>
{
  private readonly logger = new Logger(SaveFeederCalibrationsHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: SaveFeederCalibrationsCommand): Promise<FeederCalibration[]> {
    const { input, tenantId, userId } = command;
    const { equipmentId, discrete, continuous, dispense } = input;

    // WHAT: exactly one physics branch.
    //
    // WHY here rather than in class-validator: this is a relation BETWEEN two
    // sibling fields, which no per-field decorator can express. The wire format
    // already makes a MIXED row unrepresentable (each branch carries only its
    // own units); this closes the remaining two degrees of freedom, "both" and
    // "neither".
    if (discrete && continuous) {
      throw new BadRequestException(
        'A feeder is either shot-type or continuous-flow, not both. ' +
          'Supply exactly one of `discrete` / `continuous`.',
      );
    }
    if (!discrete && !continuous) {
      throw new BadRequestException(
        'Feeder setup requires the physics of the machine: supply either `discrete` ' +
          '(grams per dispensing) or `continuous` (grams per minute at a drive speed).',
      );
    }

    // WHAT: a weight-based feeder must name its mass sensor; a time-based one
    // must not name one.
    //
    // WHY both directions: the first is the operator's requirement — declaring
    // load cells that do not exist would dispense against a measurement that
    // never arrives. The second stops a dead id being carried on a feeder that
    // does not use it, where nothing would ever notice it had gone stale. The
    // database enforces the same equivalence (`CK_fcap_weight_source_required`).
    if (dispense.mode === FeederDispenseControl.WEIGHT_BASED && !dispense.weightSensorId) {
      throw new BadRequestException(
        'Weight-based dispensing requires `dispense.weightSensorId` — the mass sensor ' +
          'that reports the silo weight. Without one the feeder would wait on a ' +
          'measurement that never arrives.',
      );
    }
    if (dispense.mode === FeederDispenseControl.TIME_BASED && dispense.weightSensorId) {
      throw new BadRequestException(
        'Time-based dispensing must not carry a `dispense.weightSensorId`; the reading ' +
          'would never be consulted and could rot unnoticed.',
      );
    }

    const dosingMode = discrete ? FeederDosingMode.DISCRETE : FeederDosingMode.CONTINUOUS;
    const siloCapacityKg = (discrete ?? continuous)?.siloCapacityKg;
    const minSpeedHz = continuous?.minSpeedHz;
    const maxSpeedHz = continuous?.maxSpeedHz;

    if (continuous && !(continuous.maxSpeedHz >= continuous.minSpeedHz)) {
      throw new BadRequestException(
        `Speed band ${String(continuous.minSpeedHz)}–${String(continuous.maxSpeedHz)} Hz is ` +
          'inverted; the maximum must not be below the minimum.',
      );
    }

    const calibrations: NormalisedCalibration[] = discrete
      ? discrete.calibrations.map((cal) => ({
          feedId: cal.feedId,
          gramsPerDispensing: cal.gramsPerDispensing,
          notes: cal.notes,
        }))
      : (continuous?.calibrations ?? []).map((cal) => ({
          feedId: cal.feedId,
          gramsPerMinute: cal.gramsPerMinute,
          referenceSpeedHz: cal.referenceSpeedHz,
          notes: cal.notes,
        }));

    this.logger.log(
      `Saving ${String(calibrations.length)} ${dosingMode} calibrations for equipment ${equipmentId}`,
    );

    const duplicateFeedIds = calibrations
      .map((cal) => cal.feedId)
      .filter((feedId, index, all) => all.indexOf(feedId) !== index);
    if (duplicateFeedIds.length > 0) {
      throw new BadRequestException(
        `Duplicate feeder calibration feeds: ${Array.from(new Set(duplicateFeedIds)).join(', ')}`,
      );
    }

    // A measurement taken outside the band it is declared valid on is not a
    // measurement of anything usable. The database CHECK says the same thing;
    // saying it here turns a constraint violation into an operator-readable
    // message naming the offending feed.
    if (continuous) {
      for (const cal of calibrations) {
        const speed = cal.referenceSpeedHz;
        if (speed === undefined || speed < continuous.minSpeedHz || speed > continuous.maxSpeedHz) {
          throw new BadRequestException(
            `Feed ${cal.feedId} was calibrated at ${String(speed)} Hz, outside the feeder's ` +
              `${String(continuous.minSpeedHz)}–${String(continuous.maxSpeedHz)} Hz band. ` +
              'Flow only tracks drive speed inside that band, so a measurement taken ' +
              'outside it cannot be extrapolated back in.',
          );
        }
      }
    }

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const equipmentRepository = tenantManagerRepo(queryRunner.manager, Equipment, tenantId);
      const capabilityRepository = tenantManagerRepo(
        queryRunner.manager,
        FeederCapability,
        tenantId,
      );
      const calibrationRepository = tenantManagerRepo(
        queryRunner.manager,
        FeederCalibration,
        tenantId,
      );

      const equipment = await equipmentRepository.findOne({
        where: { id: equipmentId, isDeleted: false, tenantId },
      });
      if (!equipment) {
        throw new NotFoundException(`Equipment with ID "${equipmentId}" not found`);
      }

      // WHAT: refuse calibration on equipment that is not a feeder.
      //
      // WHY: this sink accepted ANY equipment id, so a pump could carry
      // grams-per-dispensing rows. The setup UI hid that by gating on a
      // `code.startsWith('feeder-')` string prefix — a heuristic ABOUT the
      // catalogue rather than the catalogue's own answer. The category IS that
      // answer, it is what the unit-to-feeder assignment checks, and asserting
      // it here means one definition of "feeder" holds on both paths no matter
      // which client calls.
      const equipmentType = equipment.equipmentTypeId
        ? await queryRunner.manager.findOne(EquipmentType, {
            where: { id: equipment.equipmentTypeId },
          })
        : null;
      if (equipmentType?.category !== EquipmentCategory.FEEDING) {
        throw new BadRequestException(
          `Equipment "${equipment.code}" is not a feeder (category: ${equipmentType?.category ?? 'unknown'}); ` +
            `feeder calibration belongs to FEEDING-category equipment.`,
        );
      }

      const previousCapability = await capabilityRepository.findOne({
        where: { tenantId, equipmentId },
      });
      const previousRows = await calibrationRepository.find({
        where: { equipmentId, tenantId },
        order: { feedId: 'ASC' },
      });

      // Order matters and is enforced by the FKs: the calibration rows point at
      // the capability row's (mode, band), so the old rows must go before the
      // capability can change and the new rows can only be written after it has.
      await calibrationRepository.delete({ equipmentId });

      const capability = capabilityRepository.create({
        tenantId,
        equipmentId,
        dosingMode,
        siloCapacityKg,
        minSpeedHz,
        maxSpeedHz,
        dispenseControl: dispense.mode,
        weightSensorId: dispense.weightSensorId,
        notes: input.notes,
        createdBy: previousCapability?.createdBy ?? userId,
        updatedBy: userId,
      });
      await queryRunner.manager.save(FeederCapability, capability);

      const entities = calibrations.map((cal) =>
        calibrationRepository.create({
          equipmentId,
          feedId: cal.feedId,
          dosingMode,
          gramsPerDispensing: cal.gramsPerDispensing,
          gramsPerMinute: cal.gramsPerMinute,
          referenceSpeedHz: cal.referenceSpeedHz,
          // The band is COPIED from the capability, never taken from the client:
          // there is exactly one statement of it, and `FK_fcal_feeder_speed_band`
          // makes the copy incapable of differing from that statement.
          minSpeedHz,
          maxSpeedHz,
          notes: cal.notes,
        }),
      );

      const saved = entities.length > 0 ? await calibrationRepository.saveMany(entities) : [];

      await this.auditLogService.logWithManager(queryRunner.manager, {
        tenantId,
        entityType: 'Equipment',
        entityId: equipmentId,
        action: AuditAction.UPDATE,
        userId,
        changes: {
          before: {
            feederCapability: previousCapability
              ? feederCapabilityAuditSnapshot(previousCapability)
              : null,
            feederCalibrations: previousRows.map(feederCalibrationAuditSnapshot),
          },
          after: {
            feederCapability: feederCapabilityAuditSnapshot(capability),
            feederCalibrations: saved.map(feederCalibrationAuditSnapshot),
          },
        },
        metadata: { source: 'SITES_SETUP_FEEDER_CALIBRATIONS' },
        entityVersion: equipment.version,
        summary: `Updated feeder calibrations for equipment ${equipment.code}`,
      });

      const event: FeederCalibrationsSavedEvent = {
        ...createBaseEvent<FeederCalibrationsSavedEvent>('FeederCalibrationsSaved', tenantId, {
          aggregateId: equipmentId,
          aggregateType: 'Equipment',
          userId,
        }),
        equipmentId,
        calibrationCount: saved.length,
        dosingMode,
        dispenseControl: dispense.mode,
        feedIds: saved.map((row) => row.feedId),
        changedBy: userId,
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager, {
        aggregateId: equipmentId,
      });

      this.logger.log(`Saved ${String(saved.length)} calibrations for equipment ${equipmentId}`);
      return saved;
    });
  }
}

function feederCalibrationAuditSnapshot(row: FeederCalibration): Record<string, unknown> {
  return {
    id: row.id,
    equipmentId: row.equipmentId,
    feedId: row.feedId,
    dosingMode: row.dosingMode,
    gramsPerDispensing: row.gramsPerDispensing,
    gramsPerMinute: row.gramsPerMinute,
    referenceSpeedHz: row.referenceSpeedHz,
  };
}

function feederCapabilityAuditSnapshot(row: FeederCapability): Record<string, unknown> {
  return {
    equipmentId: row.equipmentId,
    dosingMode: row.dosingMode,
    siloCapacityKg: row.siloCapacityKg,
    minSpeedHz: row.minSpeedHz,
    maxSpeedHz: row.maxSpeedHz,
    dispenseControl: row.dispenseControl,
    weightSensorId: row.weightSensorId,
  };
}
