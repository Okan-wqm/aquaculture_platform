/**
 * ScadaActivationService — the SCADA activation bridge (RT-011 Faz 3).
 *
 * This is the piece that makes SCADA RUN. Faz 1/2 made the engines multi-tenant
 * and RLS-correct, but nothing fed them: `setAlarmRules`/`loadScripts` had no
 * caller, so the 1 Hz loop iterated an empty tenant map. This service closes
 * that gap.
 *
 * Lifecycle (ADR-045 D4 — LAZY, not boot-load-ALL; boot-loading every PUBLISHED
 * package would OOM the 512 MB / 0.5 vCPU replica):
 *  - ACTIVATE on a tenant's FIRST connected operator socket. The gateway emits
 *    `SCADA_TENANT_OPERATOR_CONNECTED`; we load that tenant's PUBLISHED
 *    scada_packages, map their alarm rules into runtime shape, and feed the
 *    engine + scheduler.
 *  - REACTIVATE an already-active tenant when its package is (un)published.
 *  - EVICT idle tenants (last operator gone for > STALENESS) via a periodic
 *    sweep (the `UsageMeteringService` pattern) → `deactivateTenant` drops the
 *    in-memory state so an operator-less tenant burns no CPU.
 *
 * DI: the engine depends on the gateway (circular), so this service is reached
 * from the gateway/ScadaPackageService ONLY via EventEmitter2 events
 * (`scada-activation.events.ts`) — it injects the engines directly (they do not
 * depend on it) and reads packages itself in tenant context.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { getTenantSchemaName, runInTenantRead } from '@aquaculture/backend-common/database';

import type { ScadaScript } from '../scada-types';
import { AlarmEngineService } from './alarm-engine.service';
import { SchedulerService } from './scheduler.service';
import { mapPackageAlarmRules, type StoredAlarmRule } from './scada-package-alarm-rule.mapper';
import {
  SCADA_TENANT_OPERATOR_CONNECTED,
  SCADA_TENANT_OPERATOR_DISCONNECTED,
  SCADA_PACKAGE_PUBLISHED,
  SCADA_PACKAGE_ARCHIVED,
  type ScadaTenantOperatorEvent,
  type ScadaPackageLifecycleEvent,
} from './scada-activation.events';

const SENSOR_SCHEMA = 'sensor';

/** How long a tenant may sit with no connected operator before it is evicted. */
const IDLE_EVICTION_MS = 15 * 60 * 1000; // 15 min
/** Eviction sweep cadence. */
const EVICTION_SWEEP_MS = 5 * 60 * 1000; // 5 min

interface PackageRow {
  package_data: Record<string, unknown> | null;
}

@Injectable()
export class ScadaActivationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScadaActivationService.name);

  /** Tenants with ≥1 connected operator socket right now (never evicted). */
  private readonly connectedTenants = new Set<string>();
  /** tenantId → unix ms of the last operator lifecycle event (idle clock). */
  private readonly lastActivityMs = new Map<string, number>();

  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly alarmEngine: AlarmEngineService,
    private readonly scheduler: SchedulerService,
  ) {}

  onModuleInit(): void {
    this.evictionTimer = setInterval(() => {
      try {
        this.evictIdleTenants();
      } catch (error) {
        this.logger.error(`eviction sweep error: ${(error as Error).message}`);
      }
    }, EVICTION_SWEEP_MS);
    this.logger.log('ScadaActivationService started — lazy activation + idle eviction');
  }

  onModuleDestroy(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Operator lifecycle (from the gateway, via EventEmitter2)          */
  /* ---------------------------------------------------------------- */

  /** First operator connected for a tenant → activate lazily (D4). */
  @OnEvent(SCADA_TENANT_OPERATOR_CONNECTED)
  async handleOperatorConnected(evt: ScadaTenantOperatorEvent): Promise<void> {
    const { tenantId } = evt;
    this.connectedTenants.add(tenantId);
    this.lastActivityMs.set(tenantId, Date.now());
    await this.activateTenant(tenantId);
  }

  /** Last operator disconnected → start the idle clock; the sweep evicts later. */
  @OnEvent(SCADA_TENANT_OPERATOR_DISCONNECTED)
  handleOperatorDisconnected(evt: ScadaTenantOperatorEvent): void {
    this.connectedTenants.delete(evt.tenantId);
    this.lastActivityMs.set(evt.tenantId, Date.now());
  }

  /** Package (re)published → refresh an ACTIVE tenant's rules; no-op if inactive (D4). */
  @OnEvent(SCADA_PACKAGE_PUBLISHED)
  async handlePackagePublished(evt: ScadaPackageLifecycleEvent): Promise<void> {
    if (!this.alarmEngine.isTenantActive(evt.tenantId)) return;
    this.logger.log(`package published for active tenant=${evt.tenantId} — reloading`);
    await this.loadAndApply(evt.tenantId);
  }

  /** Package archived → drop an ACTIVE tenant's runtime; no-op if inactive. */
  @OnEvent(SCADA_PACKAGE_ARCHIVED)
  handlePackageArchived(evt: ScadaPackageLifecycleEvent): void {
    if (!this.alarmEngine.isTenantActive(evt.tenantId)) return;
    this.logger.log(`package archived for active tenant=${evt.tenantId} — deactivating`);
    this.deactivate(evt.tenantId);
  }

  /* ---------------------------------------------------------------- */
  /*  Activation                                                        */
  /* ---------------------------------------------------------------- */

  /** Activate a tenant lazily: gate on provisioning, then load its packages. */
  async activateTenant(tenantId: string): Promise<void> {
    if (this.alarmEngine.isTenantActive(tenantId)) return; // already running

    if (!(await this.isProvisioned(tenantId))) {
      // A JWT-valid tenant whose schema is not provisioned yet — skip quietly
      // (the Faz-2 write path would otherwise fail closed on first flush).
      this.logger.warn(`activateTenant: tenant=${tenantId} not provisioned — skipped`);
      return;
    }

    await this.loadAndApply(tenantId);
  }

  /**
   * Read the tenant's PUBLISHED packages in tenant context, map their alarm
   * rules + scripts into runtime shape, and feed the engine + scheduler.
   */
  private async loadAndApply(tenantId: string): Promise<void> {
    let rows: PackageRow[];
    try {
      rows = await runInTenantRead(this.dataSource, SENSOR_SCHEMA, tenantId, (qr) =>
        qr.query(`SELECT package_data FROM scada_packages WHERE status = 'published'`),
      );
    } catch (error) {
      this.logger.error(
        `loadAndApply: tenant=${tenantId} package read failed — ${(error as Error).message}`,
      );
      return;
    }

    const storedRules: StoredAlarmRule[] = [];
    const scripts: ScadaScript[] = [];
    for (const row of rows) {
      const doc = row.package_data;
      if (!doc || typeof doc !== 'object') continue;
      const docRules = (doc as { alarmRules?: unknown }).alarmRules;
      if (Array.isArray(docRules)) storedRules.push(...(docRules as StoredAlarmRule[]));
      const docScripts = (doc as { scripts?: unknown }).scripts;
      if (Array.isArray(docScripts)) scripts.push(...(docScripts as ScadaScript[]));
    }

    const { rules, dropped } = mapPackageAlarmRules(storedRules);
    if (dropped.length > 0) {
      this.logger.warn(
        `loadAndApply: tenant=${tenantId} dropped ${dropped.length} un-mappable rule(s): ` +
          dropped.map((d) => `${d.id}(${d.reason})`).join(', '),
      );
    }

    // setAlarmRules get-or-creates the tenant → this is what ACTIVATES it.
    this.alarmEngine.setAlarmRules(tenantId, rules);
    // Notification configs are not persisted in the package contract yet
    // (ORPHAN gap) — activate with none so alarms still evaluate/persist/push.
    this.alarmEngine.setNotificationConfigs(tenantId, []);
    this.scheduler.loadScripts(tenantId, scripts);

    this.logger.log(
      `activated tenant=${tenantId}: ${rules.length} alarm rule(s), ${scripts.length} script(s)`,
    );
  }

  /** Deactivate a tenant: drop engine state + its scheduled jobs. */
  private deactivate(tenantId: string): void {
    this.alarmEngine.deactivateTenant(tenantId);
    this.scheduler.loadScripts(tenantId, []); // clears this tenant's jobs
    this.lastActivityMs.delete(tenantId);
  }

  /* ---------------------------------------------------------------- */
  /*  Idle eviction sweep (UsageMeteringService pattern)                */
  /* ---------------------------------------------------------------- */

  private evictIdleTenants(): void {
    const now = Date.now();
    let evicted = 0;
    for (const [tenantId, ts] of this.lastActivityMs) {
      if (this.connectedTenants.has(tenantId)) continue; // still has operators
      if (now - ts < IDLE_EVICTION_MS) continue; // within grace period
      if (this.alarmEngine.isTenantActive(tenantId)) {
        this.deactivate(tenantId);
        evicted++;
      } else {
        this.lastActivityMs.delete(tenantId);
      }
    }
    if (evicted > 0) {
      this.logger.log(`eviction sweep: deactivated ${evicted} idle tenant(s)`);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Provisioning gate                                                 */
  /* ---------------------------------------------------------------- */

  /** True if the tenant's `tenant_<uuid>` schema exists (provisioned). */
  private async isProvisioned(tenantId: string): Promise<boolean> {
    try {
      const schema = getTenantSchemaName(tenantId);
      const rows: unknown = await this.dataSource.query(
        `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`,
        [schema],
      );
      return Array.isArray(rows) && rows.length > 0;
    } catch (error) {
      this.logger.error(
        `isProvisioned: tenant=${tenantId} check failed — ${(error as Error).message}`,
      );
      return false;
    }
  }
}
