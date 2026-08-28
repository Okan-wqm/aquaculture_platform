import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  createBaseEvent,
  TelemetryCapacityEntitlementChangedEvent,
  TelemetryCapacityEntitlementState,
  TelemetryCapacityEntitlementValues,
  TELEMETRY_PLATFORM_ENVELOPE,
} from '@platform/event-contracts';

import { TelemetryCapacityEntitlementEntity } from '../entities/telemetry-capacity-entitlement.entity';
import { BillingOutbox } from '../../outbox/billing-outbox.entity';

/**
 * Telemetry capacity reservation service (Task 8, SENSOR-HIGH-102).
 *
 * Every mutation is ONE transaction that writes the entitlement row AND the
 * outbox event together — a consumer never learns about a state the ledger
 * did not reach (and the ledger never reaches a state consumers can't see).
 *
 * Invariants (also pinned by the partial unique indexes in migration
 * 1802200000000 and by the unit suite):
 *
 *   1. A reservation that does not fit the remaining envelope lands
 *      PENDING_CAPACITY — it NEVER self-activates, and the tenant's
 *      previous ACTIVE entitlement (if any) keeps working untouched.
 *   2. Activation is an explicit, operator-driven `activate()` — the
 *      resize proof lives outside this service (droplet-capacity gate).
 *   3. At most one ACTIVE version per tenant; superseding flips the old
 *      row to SUPERSEDED in the SAME transaction that flips the new one
 *      to ACTIVE.
 */
@Injectable()
export class TelemetryCapacityService {
  private readonly logger = new Logger(TelemetryCapacityService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Reserve capacity for a tenant (first entitlement or a resize request).
   * Returns the persisted row — callers branch on `state`.
   */
  async reserve(
    tenantId: string,
    values: TelemetryCapacityEntitlementValues,
    idempotencyKey: string,
  ): Promise<TelemetryCapacityEntitlementEntity> {
    if (!Number.isInteger(values.m) || values.m <= 0) {
      throw new Error(`telemetry capacity m must be a positive integer, got ${values.m}`);
    }
    if (!Number.isInteger(values.r) || values.r <= 0) {
      throw new Error(`telemetry capacity r must be a positive integer, got ${values.r}`);
    }

    return this.dataSource.transaction(async (manager) => {
      // Idempotent retry: the SAME command (idempotency key IS the row id)
      // resolves to the row it created before, not a second one.
      const existing = await manager.findOne(TelemetryCapacityEntitlementEntity, {
        where: { id: idempotencyKey },
      });
      if (existing) return existing;

      const version =
        (await manager.count(TelemetryCapacityEntitlementEntity, { where: { tenantId } })) + 1;

      const activeSum = await this.sumActiveM();
      const remaining = TELEMETRY_PLATFORM_ENVELOPE.totalM - activeSum;
      const fits = values.m <= remaining;

      const row = manager.create(TelemetryCapacityEntitlementEntity, {
        id: idempotencyKey,
        tenantId,
        version,
        state: fits
          ? TelemetryCapacityEntitlementState.ACTIVE
          : TelemetryCapacityEntitlementState.PENDING_CAPACITY,
        m: values.m,
        r: values.r,
        observedRemainingM: remaining,
      });
      const saved = await manager.save(TelemetryCapacityEntitlementEntity, row);

      await this.emit(manager, {
        eventType: 'TelemetryCapacityEntitlementChanged',
        tenantId,
        version,
        fromState: TelemetryCapacityEntitlementState.PENDING_CAPACITY,
        toState: saved.state,
        values,
        remainingM: remaining,
      });

      if (!fits) {
        this.logger.warn(
          `telemetry capacity reservation PENDING_CAPACITY: tenant=${tenantId} ` +
            `requested m=${values.m} but only ${remaining} of the envelope remains`,
        );
      }
      return saved;
    });
  }

  /**
   * Activate a tenant's PENDING_CAPACITY reservation (operator-driven, after
   * the resize proof). Supersedes any previous ACTIVE row in the same tx.
   * Fails closed when the envelope still cannot fit the pending values.
   */
  async activate(tenantId: string): Promise<TelemetryCapacityEntitlementEntity> {
    return this.dataSource.transaction(async (manager) => {
      const pending = await manager.findOne(TelemetryCapacityEntitlementEntity, {
        where: { tenantId, state: TelemetryCapacityEntitlementState.PENDING_CAPACITY },
      });
      if (!pending) {
        throw new Error(`tenant ${tenantId} has no PENDING_CAPACITY entitlement to activate`);
      }

      const activeSum = await this.sumActiveM();
      const remaining = TELEMETRY_PLATFORM_ENVELOPE.totalM - activeSum;
      if (pending.m > remaining) {
        throw new Error(
          `activation refused: tenant ${tenantId} pending m=${pending.m} exceeds ` +
            `remaining envelope ${remaining} — the resize proof has not landed`,
        );
      }

      // Supersede the old ACTIVE first — same tx, so the partial unique
      // index never observes two ACTIVE rows.
      const previousActive = await manager.findOne(TelemetryCapacityEntitlementEntity, {
        where: { tenantId, state: TelemetryCapacityEntitlementState.ACTIVE },
      });
      if (previousActive) {
        previousActive.state = TelemetryCapacityEntitlementState.SUPERSEDED;
        await manager.save(TelemetryCapacityEntitlementEntity, previousActive);
        await this.emit(manager, {
          eventType: 'TelemetryCapacityEntitlementChanged',
          tenantId,
          version: previousActive.version,
          fromState: TelemetryCapacityEntitlementState.ACTIVE,
          toState: TelemetryCapacityEntitlementState.SUPERSEDED,
          values: { m: previousActive.m, r: previousActive.r },
          remainingM: remaining + previousActive.m,
        });
      }

      pending.state = TelemetryCapacityEntitlementState.ACTIVE;
      const saved = await manager.save(TelemetryCapacityEntitlementEntity, pending);
      await this.emit(manager, {
        eventType: 'TelemetryCapacityEntitlementChanged',
        tenantId,
        version: saved.version,
        fromState: TelemetryCapacityEntitlementState.PENDING_CAPACITY,
        toState: TelemetryCapacityEntitlementState.ACTIVE,
        values: { m: saved.m, r: saved.r },
        remainingM: remaining - saved.m,
      });
      return saved;
    });
  }

  /** Release the tenant's ACTIVE entitlement (subscription end / revoke). */
  async release(tenantId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const active = await manager.findOne(TelemetryCapacityEntitlementEntity, {
        where: { tenantId, state: TelemetryCapacityEntitlementState.ACTIVE },
      });
      if (!active) return;

      active.state = TelemetryCapacityEntitlementState.RELEASED;
      await manager.save(TelemetryCapacityEntitlementEntity, active);
      const remaining = TELEMETRY_PLATFORM_ENVELOPE.totalM - (await this.sumActiveM()) + active.m;
      await this.emit(manager, {
        eventType: 'TelemetryCapacityEntitlementChanged',
        tenantId,
        version: active.version,
        fromState: TelemetryCapacityEntitlementState.ACTIVE,
        toState: TelemetryCapacityEntitlementState.RELEASED,
        values: { m: active.m, r: active.r },
        remainingM: remaining,
      });
    });
  }

  /** Σ m over every tenant's ACTIVE entitlement (the envelope's used side). */
  private async sumActiveM(): Promise<number> {
    const rows: Array<{ total: string | null }> = await this.dataSource.query(
      `SELECT COALESCE(SUM(m), 0)::text AS total
         FROM billing.telemetry_capacity_entitlements
        WHERE state = 'ACTIVE'`,
    );
    return Number(rows[0]?.total ?? '0');
  }

  /** Same-tx outbox enqueue — the only publish path for this domain. */
  private async emit(
    manager: EntityManager,
    event: TelemetryCapacityEntitlementChangedEvent,
  ): Promise<void> {
    const base = createBaseEvent(event.eventType, event.tenantId);
    const outboxRow = manager.create(BillingOutbox, {
      eventType: event.eventType,
      tenantId: event.tenantId,
      payload: { ...base, ...event } as Record<string, unknown>,
      idempotencyKey: `tce:${event.tenantId}:${event.version}:${event.toState}`,
    });
    await manager.save(BillingOutbox, outboxRow);
  }
}
