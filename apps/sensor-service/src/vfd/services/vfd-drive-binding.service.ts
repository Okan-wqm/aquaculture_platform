/**
 * VfdDriveBindingService — the single answer to "what does this drive turn, and
 * does that imply a unit?".
 *
 * WHAT: binds a VFD to the farm `equipment` row it actuates, holds the attestation
 * farm-service gives back, and resolves — as a closed set of outcomes — whether a
 * unit follows from that equipment.
 *
 * THE MODEL, and it is deliberately two layers:
 *
 *   VfdDevice  ->  the Equipment it drives          (feeder, pump, blower, …)
 *   if that equipment is a feeder
 *       ->  its unit(s) come from the FeederAssignment farm-service owns
 *   otherwise
 *       ->  there is no unit, and that is an ANSWER, not a failure
 *
 * A drive is not "a feeder drive". Binding is generic; unit derivation is the
 * narrower thing layered on top. `resolveDrivenUnit` returns a discriminated union
 * precisely so a caller cannot reach a unit without having said out loud what it
 * intends to do about a pump, an unbound drive, and a lapsed attestation.
 *
 * WHAT THIS CANNOT GUARANTEE. farm-service owns equipment; sensor-service owns the
 * drive; a cross-service foreign key is not available (the two per-tenant table
 * sets are granted to different database roles, and coupling one service's DDL to
 * another's table would trade this defect for a deploy-ordering one). So the
 * binding is a soft reference, exactly like `Equipment.temperatureSensorId` in the
 * other direction, and it can be WRONG for as long as the news takes to arrive:
 *
 *   - equipment deleted        -> `EquipmentDeleted` moves the binding to
 *                                 UNKNOWN_EQUIPMENT and it stops actuating.
 *   - assignment ended/changed -> `UnitFeederAssignmentsChanged` rewrites the
 *                                 served units for that unit.
 *   - the news never arrives   -> this is the residual risk, and it is bounded
 *                                 rather than silent: an attestation older than
 *                                 ATTESTATION_MAX_AGE_MS is refused, and one older
 *                                 than ATTESTATION_REFRESH_AFTER_MS is re-asked
 *                                 long before it can expire. A drive whose owner
 *                                 has been unreachable for a day stops actuating
 *                                 instead of acting on day-old truth.
 *
 * @module Vfd/Services
 */
import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { IEventBus } from '@platform/event-bus';
import { createBaseEvent } from '@platform/event-contracts';
import type { VfdDriveBindingAttestationRequestedEvent } from '@platform/event-contracts';

import { VfdDriveBinding, VfdDriveBindingState } from '../entities/vfd-drive-binding.entity';
import { VfdDriveBindingUnit } from '../entities/vfd-drive-binding-unit.entity';

/**
 * `equipment_types.category` value that makes a unit meaningful. Every other
 * category (pump, aeration, filtration, …) drives something that serves no unit.
 * Mirrors `EquipmentCategory.FEEDING` in farm-service, which is the SSoT; the
 * literal is duplicated rather than imported because a service may not reach into
 * another service's domain enums.
 */
export const FEEDING_EQUIPMENT_CATEGORY = 'feeding';

/** Re-ask the owner once an attestation reaches this age (well before expiry). */
export const ATTESTATION_REFRESH_AFTER_MS = 60 * 60 * 1000;

/** Refuse to actuate on an attestation older than this. */
export const ATTESTATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Floor between two questions about the same drive, so a mute owner is not flooded. */
export const ATTESTATION_REQUEST_MIN_INTERVAL_MS = 60 * 1000;

/** A unit the driven equipment serves, as last attested. */
export interface DrivenUnit {
  unitId: string;
  unitType: string;
  unitCode: string;
  doseSharePercent: number;
}

/**
 * Every outcome of asking a drive which unit it serves. There is no `null` branch
 * on purpose: "no unit" has four distinct causes and they call for four different
 * operator actions, so collapsing them into a nullable would be the same class of
 * defect as the hand-typed `tank_id` this replaces.
 */
export type DrivenUnitResolution =
  /** No equipment is recorded for this drive. It must not actuate. */
  | { kind: 'unbound' }
  /** Bound, but the owner has not confirmed the equipment. It must not actuate. */
  | {
      kind: 'unattested';
      drivenEquipmentId: string;
      state: VfdDriveBindingState;
    }
  /** Bound and once confirmed, but the confirmation aged out. It must not actuate. */
  | { kind: 'expired'; drivenEquipmentId: string; attestedAt: Date }
  /** A pump, a blower, anything not a feeder: no unit, and asking for one is meaningless. */
  | { kind: 'not_a_feeder'; drivenEquipmentId: string; equipmentCategory: string }
  /** A feeder that currently feeds nothing — its assignments ended. */
  | { kind: 'feeder_without_unit'; drivenEquipmentId: string }
  /** A feeder serving several units: there is no single unit, and no guess is made. */
  | { kind: 'feeder_ambiguous'; drivenEquipmentId: string; units: DrivenUnit[] }
  /** The one case where a unit exists. */
  | { kind: 'feeder_unit'; drivenEquipmentId: string; unit: DrivenUnit };

@Injectable()
export class VfdDriveBindingService {
  private readonly logger = new Logger(VfdDriveBindingService.name);

  constructor(
    @InjectRepository(VfdDriveBinding)
    private readonly bindingRepository: Repository<VfdDriveBinding>,
    @InjectRepository(VfdDriveBindingUnit)
    private readonly unitRepository: Repository<VfdDriveBindingUnit>,
    // @Optional so `new`-based unit tests and bus-less boots work. A drive bound
    // while the bus is down stays PENDING — it cannot actuate, which is the safe
    // direction, and the next resolve re-asks.
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus?: IEventBus,
  ) {}

  /**
   * Record the equipment a drive actuates and ask its owner to confirm.
   *
   * The binding is written PENDING, never straight to attested: sensor-service has
   * no standing to declare what a farm equipment row is. Until the answer arrives
   * the drive cannot actuate.
   */
  async bind(
    vfdDeviceId: string,
    tenantId: string,
    drivenEquipmentId: string,
    boundBy?: string,
  ): Promise<VfdDriveBinding> {
    if (!drivenEquipmentId) {
      throw new BadRequestException('drivenEquipmentId is required to bind a drive');
    }

    const now = new Date();
    const existing = await this.bindingRepository.findOne({
      where: { vfdDeviceId, tenantId },
    });

    // Re-pointing a drive at different equipment invalidates everything the old
    // attestation said, units included — otherwise a drive re-bound from a feeder
    // to a pump would keep feeding a tank it no longer touches.
    if (existing && existing.drivenEquipmentId !== drivenEquipmentId) {
      await this.unitRepository.delete({ vfdDeviceId, tenantId });
    }

    const binding = this.bindingRepository.create({
      vfdDeviceId,
      tenantId,
      drivenEquipmentId,
      state: VfdDriveBindingState.PENDING,
      equipmentCategory: undefined,
      equipmentCode: undefined,
      equipmentName: undefined,
      siteId: undefined,
      requestedAt: now,
      attestedAt: undefined,
      boundBy,
    });
    const saved = await this.bindingRepository.save(binding);

    await this.publishAttestationRequest(tenantId, vfdDeviceId, drivenEquipmentId);
    return saved;
  }

  /** Forget the binding. The drive stops actuating until it is bound again. */
  async unbind(vfdDeviceId: string, tenantId: string): Promise<boolean> {
    await this.unitRepository.delete({ vfdDeviceId, tenantId });
    const result = await this.bindingRepository.delete({ vfdDeviceId, tenantId });
    return (result.affected ?? 0) > 0;
  }

  /** The binding row as stored, or null. Read path for display surfaces. */
  async findBinding(vfdDeviceId: string, tenantId: string): Promise<VfdDriveBinding | null> {
    return this.bindingRepository.findOne({ where: { vfdDeviceId, tenantId } });
  }

  /** The attested served units, share-descending then code — deterministic display. */
  async findUnits(vfdDeviceId: string, tenantId: string): Promise<VfdDriveBindingUnit[]> {
    return this.unitRepository.find({
      where: { vfdDeviceId, tenantId },
      order: { doseSharePercent: 'DESC', unitCode: 'ASC' },
    });
  }

  /**
   * Which unit does this drive serve? Every non-answer is a named outcome.
   *
   * Re-asks the owner as a side effect when the held answer is missing or ageing,
   * so the repair happens without an operator noticing something is wrong.
   */
  async resolveDrivenUnit(vfdDeviceId: string, tenantId: string): Promise<DrivenUnitResolution> {
    const binding = await this.bindingRepository.findOne({ where: { vfdDeviceId, tenantId } });
    if (!binding) {
      return { kind: 'unbound' };
    }

    await this.refreshAttestationIfDue(binding);

    if (binding.state !== VfdDriveBindingState.ATTESTED || !binding.attestedAt) {
      return {
        kind: 'unattested',
        drivenEquipmentId: binding.drivenEquipmentId,
        state: binding.state,
      };
    }

    if (Date.now() - binding.attestedAt.getTime() > ATTESTATION_MAX_AGE_MS) {
      return {
        kind: 'expired',
        drivenEquipmentId: binding.drivenEquipmentId,
        attestedAt: binding.attestedAt,
      };
    }

    if (binding.equipmentCategory !== FEEDING_EQUIPMENT_CATEGORY) {
      // A pump or a blower. There is no unit to derive, and that is the whole
      // answer — the caller must not fabricate one.
      return {
        kind: 'not_a_feeder',
        drivenEquipmentId: binding.drivenEquipmentId,
        equipmentCategory: binding.equipmentCategory ?? '',
      };
    }

    const units = await this.findUnits(vfdDeviceId, tenantId);
    if (units.length === 0) {
      return { kind: 'feeder_without_unit', drivenEquipmentId: binding.drivenEquipmentId };
    }
    if (units.length > 1) {
      return {
        kind: 'feeder_ambiguous',
        drivenEquipmentId: binding.drivenEquipmentId,
        units: units.map((row) => this.toDrivenUnit(row)),
      };
    }

    return {
      kind: 'feeder_unit',
      drivenEquipmentId: binding.drivenEquipmentId,
      unit: this.toDrivenUnit(units[0]!),
    };
  }

  /**
   * Gate for every command that moves a shaft.
   *
   * Passes only when the equipment identity is attested and the attestation is
   * fresh. It deliberately does NOT require a unit: a pump legitimately serves
   * none, and a feeder whose assignment lapsed still needs to be able to run —
   * refusing that would stop feeding, which is the worse welfare outcome. What it
   * refuses is acting against an identity nobody has confirmed, or confirmed too
   * long ago to still stand behind.
   */
  async assertActuable(vfdDeviceId: string, tenantId: string): Promise<void> {
    const resolution = await this.resolveDrivenUnit(vfdDeviceId, tenantId);

    switch (resolution.kind) {
      case 'unbound':
        throw new BadRequestException(
          `VFD ${vfdDeviceId} is not bound to the equipment it drives. A drive with no ` +
            `recorded equipment cannot be commanded — bind it first.`,
        );
      case 'unattested':
        throw new BadRequestException(
          `VFD ${vfdDeviceId} drives equipment ${resolution.drivenEquipmentId}, which the ` +
            `owning service has not confirmed (${resolution.state}). Command refused.`,
        );
      case 'expired':
        throw new BadRequestException(
          `VFD ${vfdDeviceId}'s equipment binding was last confirmed at ` +
            `${resolution.attestedAt.toISOString()} and has aged out. Command refused until ` +
            `it is re-confirmed.`,
        );
      default:
        return;
    }
  }

  /**
   * Apply an attestation from the equipment's owner. Called by the listener.
   *
   * The served-unit set is REPLACED, never merged: the attestation carries the
   * complete current set, so a feeder that lost an assignment must lose the row.
   */
  async applyAttestation(input: {
    vfdDeviceId: string;
    tenantId: string;
    drivenEquipmentId: string;
    outcome: 'attested' | 'unknown_equipment' | 'inactive_equipment';
    equipmentCategory?: string;
    equipmentCode?: string;
    equipmentName?: string;
    siteId?: string;
    servedUnits: DrivenUnit[];
    attestedAt: Date;
  }): Promise<void> {
    const binding = await this.bindingRepository.findOne({
      where: { vfdDeviceId: input.vfdDeviceId, tenantId: input.tenantId },
    });
    if (!binding) {
      this.logger.debug(
        `Attestation for unknown VFD binding ${input.vfdDeviceId} — the drive was unbound ` +
          `while the answer was in flight; discarding.`,
      );
      return;
    }
    // An answer about equipment the drive is no longer pointed at is stale by
    // construction; applying it would resurrect a binding the operator replaced.
    if (binding.drivenEquipmentId !== input.drivenEquipmentId) {
      this.logger.debug(
        `Attestation for ${input.drivenEquipmentId} does not match the current binding ` +
          `${binding.drivenEquipmentId} on VFD ${input.vfdDeviceId}; discarding.`,
      );
      return;
    }

    binding.state = this.stateForOutcome(input.outcome);
    binding.equipmentCategory = input.equipmentCategory;
    binding.equipmentCode = input.equipmentCode;
    binding.equipmentName = input.equipmentName;
    binding.siteId = input.siteId;
    binding.attestedAt = input.attestedAt;
    await this.bindingRepository.save(binding);

    await this.unitRepository.delete({
      vfdDeviceId: input.vfdDeviceId,
      tenantId: input.tenantId,
    });
    if (input.outcome === 'attested' && input.servedUnits.length > 0) {
      await this.unitRepository.save(
        input.servedUnits.map((unit) =>
          this.unitRepository.create({
            vfdDeviceId: input.vfdDeviceId,
            tenantId: input.tenantId,
            unitId: unit.unitId,
            unitType: unit.unitType,
            unitCode: unit.unitCode,
            doseSharePercent: unit.doseSharePercent,
          }),
        ),
      );
    }
  }

  /**
   * Revoke every binding onto a deleted equipment row.
   *
   * The drives stop actuating immediately rather than at the next attestation
   * refresh — a deleted machine is the one case where waiting for a TTL would mean
   * spinning something that is no longer supposed to exist.
   */
  async revokeForEquipment(tenantId: string, drivenEquipmentId: string): Promise<number> {
    const bindings = await this.bindingRepository.find({
      where: { tenantId, drivenEquipmentId },
    });
    for (const binding of bindings) {
      binding.state = VfdDriveBindingState.UNKNOWN_EQUIPMENT;
      binding.attestedAt = undefined;
      await this.bindingRepository.save(binding);
      await this.unitRepository.delete({ vfdDeviceId: binding.vfdDeviceId, tenantId });
    }
    return bindings.length;
  }

  /**
   * Rewrite the served units for ONE unit across every drive, from the complete
   * active feeder set farm-service just published for that unit.
   *
   * Feeders present in the event get their row written; feeders that previously
   * had a row for this unit and are absent from the event lose it. That is what
   * turns "the assignment ended" into a drive that no longer claims the unit.
   */
  async applyUnitFeederSet(input: {
    tenantId: string;
    unitId: string;
    unitType: string;
    unitCode: string;
    feeders: ReadonlyArray<{ feederEquipmentId: string; doseSharePercent: number }>;
  }): Promise<void> {
    const { tenantId, unitId } = input;
    const shareByEquipment = new Map(
      input.feeders.map((feeder) => [feeder.feederEquipmentId, feeder.doseSharePercent] as const),
    );

    // Every drive that currently claims this unit, plus every drive bound to a
    // feeder the event names — the union is exactly the set whose rows can change.
    const claiming = await this.unitRepository.find({ where: { tenantId, unitId } });
    const boundToNamedFeeders = shareByEquipment.size
      ? await this.bindingRepository.find({
          where: { tenantId, drivenEquipmentId: In([...shareByEquipment.keys()]) },
        })
      : [];

    for (const row of claiming) {
      const binding = await this.bindingRepository.findOne({
        where: { vfdDeviceId: row.vfdDeviceId, tenantId },
      });
      if (!binding || !shareByEquipment.has(binding.drivenEquipmentId)) {
        await this.unitRepository.delete({ vfdDeviceId: row.vfdDeviceId, tenantId, unitId });
      }
    }

    for (const binding of boundToNamedFeeders) {
      await this.unitRepository.save(
        this.unitRepository.create({
          vfdDeviceId: binding.vfdDeviceId,
          tenantId,
          unitId,
          unitType: input.unitType,
          unitCode: input.unitCode,
          doseSharePercent: shareByEquipment.get(binding.drivenEquipmentId)!,
        }),
      );
    }
  }

  /**
   * Ask again when the held answer is missing or ageing.
   *
   * Rate-limited on `requestedAt` so a farm-service outage produces one question
   * per drive per minute rather than one per read.
   */
  private async refreshAttestationIfDue(binding: VfdDriveBinding): Promise<void> {
    const now = Date.now();
    const attestationIsStale =
      binding.state !== VfdDriveBindingState.ATTESTED ||
      !binding.attestedAt ||
      now - binding.attestedAt.getTime() > ATTESTATION_REFRESH_AFTER_MS;
    if (!attestationIsStale) {
      return;
    }
    if (now - binding.requestedAt.getTime() < ATTESTATION_REQUEST_MIN_INTERVAL_MS) {
      return;
    }

    binding.requestedAt = new Date(now);
    await this.bindingRepository.save(binding);
    await this.publishAttestationRequest(
      binding.tenantId,
      binding.vfdDeviceId,
      binding.drivenEquipmentId,
    );
  }

  private async publishAttestationRequest(
    tenantId: string,
    vfdDeviceId: string,
    drivenEquipmentId: string,
  ): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn(
        `EVENT_BUS unavailable — cannot ask for attestation of equipment ${drivenEquipmentId} ` +
          `for VFD ${vfdDeviceId}. The drive stays unattested and will not actuate.`,
      );
      return;
    }
    const event: VfdDriveBindingAttestationRequestedEvent = {
      ...createBaseEvent<VfdDriveBindingAttestationRequestedEvent>(
        'VfdDriveBindingAttestationRequested',
        tenantId,
        { aggregateId: vfdDeviceId, aggregateType: 'VfdDevice' },
      ),
      vfdDeviceId,
      drivenEquipmentId,
    };
    try {
      await this.eventBus.publish(event);
    } catch (error) {
      // A question that could not be asked is not a reason to fail the operator's
      // bind: the binding is already PENDING, which cannot actuate, and the next
      // resolve asks again.
      this.logger.warn(
        `Failed to publish attestation request for VFD ${vfdDeviceId}: ${(error as Error).message}`,
      );
    }
  }

  private stateForOutcome(
    outcome: 'attested' | 'unknown_equipment' | 'inactive_equipment',
  ): VfdDriveBindingState {
    switch (outcome) {
      case 'attested':
        return VfdDriveBindingState.ATTESTED;
      case 'inactive_equipment':
        return VfdDriveBindingState.INACTIVE_EQUIPMENT;
      case 'unknown_equipment':
        return VfdDriveBindingState.UNKNOWN_EQUIPMENT;
    }
  }

  private toDrivenUnit(row: VfdDriveBindingUnit): DrivenUnit {
    return {
      unitId: row.unitId,
      unitType: row.unitType,
      unitCode: row.unitCode,
      doseSharePercent: row.doseSharePercent,
    };
  }
}
