/**
 * VfdDriveBindingListener — keeps a drive's picture of the equipment it turns in
 * step with the service that owns that equipment.
 *
 * Three subjects, three jobs:
 *
 *   VfdDriveBindingAttested        the answer to a question this service asked.
 *                                  Records what the equipment is and which units
 *                                  it serves, or records that it is unknown.
 *   EquipmentDeleted               revocation. Every drive bound to the deleted
 *                                  row stops actuating at once, rather than at the
 *                                  next attestation refresh.
 *   UnitFeederAssignmentsChanged   a unit's feeder set changed. Rewrites which
 *                                  drives claim that unit, so an ended assignment
 *                                  stops being claimed by anybody.
 *
 * WHY revocation is separate from attestation: an attestation is a pull (we asked,
 * they answered) and can be at most `ATTESTATION_REFRESH_AFTER_MS` behind. A
 * deleted machine cannot wait that long — it is the one change where acting on the
 * previous answer means moving a shaft that should not exist.
 *
 * Failures RETHROW so NATS redelivers: a dropped revocation would leave a drive
 * actuating against equipment that is gone, which is the exact failure this whole
 * mechanism exists to prevent.
 *
 * @module Vfd/Services
 */
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import type { IEventBus, IEventHandler } from '@platform/event-bus';
import { validateFarmEvent } from '@platform/event-contracts';
import type {
  BaseEvent,
  EquipmentDeletedEvent,
  UnitFeederAssignmentsChangedEvent,
  VfdDriveBindingAttestedEvent,
} from '@platform/event-contracts';
import { isValidUUID } from '@aquaculture/backend-common/database';

import { VfdDriveBindingService } from './vfd-drive-binding.service';

@Injectable()
export class VfdDriveBindingListener implements OnModuleInit, IEventHandler<BaseEvent> {
  private readonly logger = new Logger(VfdDriveBindingListener.name);

  /**
   * Tenant wildcard, eventType discriminator in the third segment — the shape
   * `deriveSubject` publishes (`events.{tenantId}.{eventType}`). A two-segment
   * subscribe would silently match nothing.
   */
  private static readonly SUBJECTS = [
    'events.*.VfdDriveBindingAttested',
    'events.*.EquipmentDeleted',
    'events.*.UnitFeederAssignmentsChanged',
  ] as const;

  constructor(
    private readonly bindingService: VfdDriveBindingService,
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus?: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn(
        'EVENT_BUS not provided; VfdDriveBindingListener will not subscribe. Drive bindings ' +
          'will never be attested, so no VFD will accept a command.',
      );
      return;
    }
    for (const subject of VfdDriveBindingListener.SUBJECTS) {
      await this.eventBus.subscribeTo<BaseEvent>(subject, this);
    }
    this.logger.log(
      `Subscribed to ${VfdDriveBindingListener.SUBJECTS.length} subjects for VFD drive bindings`,
    );
  }

  /** Informational — the real subject list is the static SUBJECTS array. */
  getEventType(): string {
    return 'events.*.{VfdDriveBindingAttested,EquipmentDeleted,UnitFeederAssignmentsChanged}';
  }

  async handle(event: BaseEvent): Promise<void> {
    if (!event.tenantId || !isValidUUID(event.tenantId)) {
      this.logger.error(
        `${event.eventType} carries a missing/invalid tenantId — dropped to prevent ` +
          'cross-tenant binding corruption.',
      );
      return;
    }

    switch (event.eventType) {
      case 'VfdDriveBindingAttested':
        return this.onAttested(event as VfdDriveBindingAttestedEvent);
      case 'EquipmentDeleted':
        return this.onEquipmentDeleted(event as EquipmentDeletedEvent);
      case 'UnitFeederAssignmentsChanged':
        return this.onUnitFeedersChanged(event as UnitFeederAssignmentsChangedEvent);
      default:
        return;
    }
  }

  private async onAttested(event: VfdDriveBindingAttestedEvent): Promise<void> {
    // This is the message that decides whether an actuator may move. Judge the
    // shape before believing it: a wrong-typed `outcome` or an unexpected field
    // would otherwise pass the consumer's static narrowing untouched.
    const validation = validateFarmEvent('VfdDriveBindingAttested', event);
    if (!validation.valid) {
      this.logger.error(
        `VfdDriveBindingAttested failed schema validation — dropped, the drive stays ` +
          `unattested and will not actuate: ${validation.errors}`,
      );
      return;
    }
    if (!isValidUUID(event.vfdDeviceId) || !isValidUUID(event.drivenEquipmentId)) {
      this.logger.warn('VfdDriveBindingAttested carries malformed ids — dropped.');
      return;
    }
    // The stamp is the event's own timestamp, not `now`: it is the moment the
    // owner looked, and the freshness window is judged against that, not against
    // when the message happened to be delivered.
    const attestedAt = new Date(event.timestamp);
    await this.bindingService.applyAttestation({
      vfdDeviceId: event.vfdDeviceId,
      tenantId: event.tenantId,
      drivenEquipmentId: event.drivenEquipmentId,
      outcome: event.outcome,
      equipmentCategory: event.equipmentCategory,
      equipmentCode: event.equipmentCode,
      equipmentName: event.equipmentName,
      siteId: event.siteId,
      servedUnits: (event.servedUnits ?? []).map((unit) => ({
        unitId: unit.unitId,
        unitType: unit.unitType,
        unitCode: unit.unitCode,
        doseSharePercent: unit.doseSharePercent,
      })),
      attestedAt: Number.isNaN(attestedAt.getTime()) ? new Date() : attestedAt,
    });
  }

  private async onEquipmentDeleted(event: EquipmentDeletedEvent): Promise<void> {
    if (!isValidUUID(event.equipmentId)) {
      return;
    }
    const revoked = await this.bindingService.revokeForEquipment(event.tenantId, event.equipmentId);
    if (revoked > 0) {
      this.logger.warn(
        `Equipment ${event.code} was deleted; ${revoked} VFD drive binding(s) revoked and ` +
          'those drives will refuse commands until they are re-bound.',
      );
    }
  }

  private async onUnitFeedersChanged(event: UnitFeederAssignmentsChangedEvent): Promise<void> {
    if (!isValidUUID(event.unitId)) {
      return;
    }
    await this.bindingService.applyUnitFeederSet({
      tenantId: event.tenantId,
      unitId: event.unitId,
      unitType: event.unitType,
      unitCode: event.unitCode,
      feeders: (event.feeders ?? []).map((feeder) => ({
        feederEquipmentId: feeder.feederEquipmentId,
        doseSharePercent: feeder.doseSharePercent,
      })),
    });
  }
}
