/**
 * VfdDriveBindingAttestationListener — farm-service answers "what is the equipment
 * this drive turns?".
 *
 * WHY farm-service answers at all: it owns equipment identity. sensor-service owns
 * the VFD and can store an `equipment.id`, but it has no standing to decide what
 * that id IS — whether the row exists, whether it is in service, whether it is a
 * feeder or a pump, and which units a feeder currently serves. Every one of those
 * facts lives here, so the answer is issued here.
 *
 * WHY an event and not an endpoint: the asker is an actuator's command path. A
 * synchronous call would put this service's availability in front of "can the fish
 * be fed"; an answer that the drive holds and re-asks for does not. The cost is
 * that the drive's copy can lag — bounded on the sensor side by an expiry the
 * drive refuses to act past.
 *
 * The answer is COMPLETE, never a delta: `servedUnits` is the whole current set,
 * so an empty list from a feeder means "it feeds nothing right now" rather than
 * "no news".
 *
 * @module Events/Listeners
 */
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import type { IEventBus, IEventHandler } from '@platform/event-bus';
import { createBaseEvent, validateSensorEvent } from '@platform/event-contracts';
import type {
  BaseEvent,
  DrivenEquipmentUnitEntry,
  VfdDriveBindingAttestationRequestedEvent,
  VfdDriveBindingAttestedEvent,
} from '@platform/event-contracts';
import {
  isValidUUID,
  runInTenantRead,
  tenantManagerRepo,
} from '@aquaculture/backend-common/database';
import { DataSource } from 'typeorm';

import { resolveSiteIdFromDepartment } from '../../batch/utils/tank-lookup.util';
import { EquipmentCategory, EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import {
  FeederAssignment,
  FeederAssignmentStatus,
} from '../../feeding-protocol/entities/feeder-assignment.entity';

/** What the lookup found, before it is shaped into an event. */
interface AttestationFacts {
  outcome: 'attested' | 'unknown_equipment' | 'inactive_equipment';
  equipmentCategory?: string;
  equipmentCode?: string;
  equipmentName?: string;
  siteId?: string;
  servedUnits: DrivenEquipmentUnitEntry[];
}

@Injectable()
export class VfdDriveBindingAttestationListener implements OnModuleInit, IEventHandler<BaseEvent> {
  private readonly logger = new Logger(VfdDriveBindingAttestationListener.name);

  constructor(
    private readonly dataSource: DataSource,
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus?: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn(
        'EVENT_BUS not available — VFD drive-binding attestation subscription skipped. ' +
          'No VFD will be able to confirm the equipment it drives, so none will actuate.',
      );
      return;
    }
    await this.eventBus.subscribeWildcard('VfdDriveBindingAttestationRequested', this);
    this.logger.log('Subscribed to VfdDriveBindingAttestationRequested (cross-tenant)');
  }

  getEventType(): string {
    return 'VfdDriveBindingAttestationRequested';
  }

  async handle(event: BaseEvent): Promise<void> {
    if (!event.tenantId || !isValidUUID(event.tenantId)) {
      this.logger.error(
        'VfdDriveBindingAttestationRequested has a missing/invalid tenantId — dropped to ' +
          'prevent answering one tenant with another tenant’s equipment.',
      );
      return;
    }
    // A request off the bus makes this service go looking through a tenant's
    // equipment. Judge the shape first — a malformed id has no business reaching
    // that lookup, and an unexpected field has none being carried into the answer.
    const validation = validateSensorEvent('VfdDriveBindingAttestationRequested', event);
    if (!validation.valid) {
      this.logger.warn(
        `VfdDriveBindingAttestationRequested failed schema validation — dropped: ` +
          `${validation.errors}`,
      );
      return;
    }

    const request = event as VfdDriveBindingAttestationRequestedEvent;
    if (!isValidUUID(request.vfdDeviceId) || !isValidUUID(request.drivenEquipmentId)) {
      this.logger.warn(
        'VfdDriveBindingAttestationRequested carries malformed ids — dropped; a malformed id ' +
          'cannot name equipment, so there is nothing to attest.',
      );
      return;
    }

    const facts = await this.lookup(event.tenantId, request.drivenEquipmentId);
    await this.publishAttestation(event.tenantId, request, facts);
  }

  /**
   * Resolve what the equipment is and, for a feeder only, which units it serves.
   *
   * A deleted row is reported as unknown rather than as "deleted": to a drive the
   * two are the same instruction — do not act on it.
   */
  private async lookup(tenantId: string, equipmentId: string): Promise<AttestationFacts> {
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const equipment = await tenantManagerRepo(queryRunner.manager, Equipment, tenantId).findOne({
        where: { id: equipmentId, tenantId, isDeleted: false },
      });

      if (!equipment) {
        return { outcome: 'unknown_equipment', servedUnits: [] } satisfies AttestationFacts;
      }

      const equipmentType = equipment.equipmentTypeId
        ? await queryRunner.manager.findOne(EquipmentType, {
            where: { id: equipment.equipmentTypeId },
          })
        : null;
      const category = equipmentType?.category;

      if (!equipment.isActive) {
        return {
          outcome: 'inactive_equipment',
          equipmentCategory: category,
          equipmentCode: equipment.code,
          equipmentName: equipment.name,
          servedUnits: [],
        } satisfies AttestationFacts;
      }

      // Units are a FEEDING-only concept. A pump or a blower gets an empty set,
      // and that emptiness is the answer — the drive is told the category so it
      // can tell "serves no unit by nature" from "serves none right now".
      const servedUnits: DrivenEquipmentUnitEntry[] =
        category === EquipmentCategory.FEEDING
          ? (
              await tenantManagerRepo(queryRunner.manager, FeederAssignment, tenantId).find({
                where: {
                  tenantId,
                  feederEquipmentId: equipment.id,
                  status: FeederAssignmentStatus.ACTIVE,
                },
                order: { doseSharePercent: 'DESC', unitCode: 'ASC' },
              })
            ).map((assignment) => ({
              unitId: assignment.unitId,
              unitType: assignment.unitType,
              unitCode: assignment.unitCode,
              doseSharePercent: assignment.doseSharePercent,
            }))
          : [];

      // Equipment carries no siteId column — the site is reached through its
      // department, the same route the feeder-assignment handler takes.
      const siteId = await resolveSiteIdFromDepartment(
        queryRunner.manager,
        equipment.departmentId,
        tenantId,
      );

      return {
        outcome: 'attested',
        equipmentCategory: category,
        equipmentCode: equipment.code,
        equipmentName: equipment.name,
        siteId: siteId ?? undefined,
        servedUnits,
      } satisfies AttestationFacts;
    });
  }

  private async publishAttestation(
    tenantId: string,
    request: VfdDriveBindingAttestationRequestedEvent,
    facts: AttestationFacts,
  ): Promise<void> {
    if (!this.eventBus) {
      return;
    }
    const event: VfdDriveBindingAttestedEvent = {
      ...createBaseEvent<VfdDriveBindingAttestedEvent>('VfdDriveBindingAttested', tenantId, {
        aggregateId: request.drivenEquipmentId,
        aggregateType: 'Equipment',
        correlationId: request.correlationId,
      }),
      vfdDeviceId: request.vfdDeviceId,
      drivenEquipmentId: request.drivenEquipmentId,
      outcome: facts.outcome,
      equipmentCategory: facts.equipmentCategory,
      equipmentCode: facts.equipmentCode,
      equipmentName: facts.equipmentName,
      siteId: facts.siteId,
      servedUnits: facts.servedUnits,
    };
    // Rethrow: a lost attestation leaves the asking drive unable to actuate, so
    // NATS must redeliver rather than silently drop the answer.
    await this.eventBus.publish(event);
  }
}
