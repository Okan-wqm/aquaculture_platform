/**
 * Save Feeder Calibrations Command Handler
 * Upsert strategy: delete existing calibrations for the equipment, then insert new ones.
 * Uses the canonical tenant transaction/audit/outbox contract so the
 * calibration set, audit row, and event row commit or roll back together.
 */
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { createBaseEvent, type FeederCalibrationsSavedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';
import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { SaveFeederCalibrationsCommand } from '../commands/save-feeder-calibrations.command';
import { Equipment } from '../entities/equipment.entity';
import { FeederCalibration } from '../entities/feeder-calibration.entity';

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
    const { equipmentId, calibrations } = input;

    this.logger.log(`Saving ${calibrations.length} calibrations for equipment ${equipmentId}`);

    const duplicateFeedSizes = calibrations
      .map((cal) => cal.feedSizeMm)
      .filter((feedSizeMm, index, all) => all.indexOf(feedSizeMm) !== index);
    if (duplicateFeedSizes.length > 0) {
      throw new BadRequestException(
        `Duplicate feeder calibration feed sizes: ${Array.from(new Set(duplicateFeedSizes)).join(', ')}`,
      );
    }

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const equipmentRepository = tenantManagerRepo(queryRunner.manager, Equipment, tenantId);
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

      const previousRows = await calibrationRepository.find({
        where: { equipmentId, tenantId },
        order: { feedSizeMm: 'ASC' },
      });

      await calibrationRepository.delete({ equipmentId });

      const entities = calibrations.map((cal) =>
        calibrationRepository.create({
          equipmentId,
          feedSizeMm: cal.feedSizeMm,
          feedSizeLabel: cal.feedSizeLabel,
          gramsPerDispensing: cal.gramsPerDispensing,
          siloCapacityKg: cal.siloCapacityKg,
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
            feederCalibrations: previousRows.map(feederCalibrationAuditSnapshot),
          },
          after: {
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
        feedSizeMm: saved.map((row) => row.feedSizeMm),
        changedBy: userId,
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager, {
        aggregateId: equipmentId,
      });

      this.logger.log(`Saved ${saved.length} calibrations for equipment ${equipmentId}`);
      return saved;
    });
  }
}

function feederCalibrationAuditSnapshot(row: FeederCalibration): Record<string, unknown> {
  return {
    id: row.id,
    equipmentId: row.equipmentId,
    feedSizeMm: row.feedSizeMm,
    feedSizeLabel: row.feedSizeLabel,
    gramsPerDispensing: row.gramsPerDispensing,
    siloCapacityKg: row.siloCapacityKg,
  };
}
