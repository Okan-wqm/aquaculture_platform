/**
 * AlarmStorageService
 *
 * Handles persistence of active alarms and alarm chronicle (history) for the
 * cross-tenant-infrastructure SCADA tables in the shared `sensor` schema.
 *
 * Tables (migration-owned):
 *   scada_alarms           — live active alarm instances (upsert)
 *   scada_alarm_chronicle  — append-only history log
 *
 * Tenant isolation (ORPHAN-414, RT-011 Faz 2)
 * ───────────────────────────────────────────
 * These tables carry a FORCED `tenant_isolation_policy`
 * (`app.bypass_rls='on' OR tenant_id = app.current_tenant`). A raw pooled write
 * with no GUC is REJECTED by Postgres. So:
 *   - Per-tenant writes (the engine knows the owning tenant) run inside
 *     `runInTenantTransaction('sensor', tenantId, …)`, which sets
 *     `app.current_tenant` transaction-locally → the policy ENFORCES the write
 *     (a mis-stamped tenant_id is refused by the DB — Tier-1).
 *   - Per-tenant reads run inside `runInTenantRead(...)` for the same reason.
 *   - The engine batches a tenant's per-tick writes into ONE `flushTenantBatch`
 *     transaction (coalescing) so the 1 Hz loop never opens a per-write
 *     transaction storm.
 *   - The genuinely cross-tenant retention sweep (`cleanupHistory`) has no
 *     per-row tenant, so it uses the audited `BypassRlsService.withBypass`
 *     (the outbox-worker precedent), not a tenant context.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';

import {
  runInTenantTransaction,
  runInTenantRead,
  BypassRlsService,
} from '@aquaculture/backend-common/database';

import type { AlarmHistoryFilter, AlarmInstance } from '../scada-types';
import type { ScadaAlarm, ScadaAlarmChronicle } from '../entities/alarm.entity';

/** Source schema that owns the cross-tenant SCADA persistence tables. */
const SENSOR_SCHEMA = 'sensor';

/* ------------------------------------------------------------------ */
/*  Internal row shapes returned by raw SQL                            */
/* ------------------------------------------------------------------ */

interface AlarmRow {
  id: string;
  rule_id: string;
  rule_name: string;
  severity: string;
  status: string;
  message: string;
  group_name: string | null;
  current_value: string;
  threshold: string;
  on_time: string;
  off_time: string | null;
  ack_time: string | null;
  ack_user_id: string | null;
  colors_bg: string | null;
  colors_text: string | null;
}

/**
 * A tenant's coalesced set of persistence intents for one flush. The engine
 * accumulates these per tick and hands the whole batch to `flushTenantBatch`,
 * which applies them in ONE tenant-context transaction.
 *  - `upserts`   — active-alarm rows to insert/update (deduped by id by caller).
 *  - `chronicles`— completed-alarm rows to append (append-only, ON CONFLICT DO NOTHING).
 *  - `deleteIds` — active-alarm ids to remove (resolved alarms).
 */
export interface ScadaAlarmWriteBatch {
  upserts: ScadaAlarm[];
  chronicles: ScadaAlarmChronicle[];
  deleteIds: string[];
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function rowToInstance(row: AlarmRow): AlarmInstance {
  return {
    id: row.id,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    severity: row.severity as AlarmInstance['severity'],
    status: row.status as AlarmInstance['status'],
    message: row.message,
    group: row.group_name ?? undefined,
    currentValue: parseFloat(row.current_value),
    threshold: parseFloat(row.threshold),
    onTime: parseInt(row.on_time, 10),
    offTime: row.off_time != null ? parseInt(row.off_time, 10) : undefined,
    ackTime: row.ack_time != null ? parseInt(row.ack_time, 10) : undefined,
    ackUserId: row.ack_user_id ?? undefined,
    colors:
      row.colors_bg != null && row.colors_text != null
        ? { background: row.colors_bg, text: row.colors_text }
        : undefined,
  };
}

/* ------------------------------------------------------------------ */
/*  Service                                                             */
/* ------------------------------------------------------------------ */

@Injectable()
export class AlarmStorageService implements OnModuleInit {
  private readonly logger = new Logger(AlarmStorageService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly bypassRls: BypassRlsService,
  ) {}

  /**
   * Fail-closed tenant guard. Every per-tenant read and write is tenant-scoped
   * (DB-SENSOR-CRITICAL-001) and additionally establishes `app.current_tenant`
   * so the FORCED RLS policy enforces it. Refusing an empty tenantId makes an
   * unbound write structurally impossible.
   */
  private assertTenant(tenantId: string): void {
    if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
      throw new Error(
        'AlarmStorageService: tenantId is required — SCADA alarm persistence is tenant-scoped and refuses an unbound tenant context',
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureTablesExist();
      this.logger.log('AlarmStorageService initialised — tables verified');
    } catch (error) {
      this.logger.error(
        `AlarmStorageService: table verification failed — ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Verify migration-owned storage tables exist before runtime writes alarms.
   * Reads catalog tables only (not RLS-protected), so no tenant context needed.
   */
  private async ensureTablesExist(): Promise<void> {
    const rows: unknown = await this.dataSource.query(
      `
      SELECT expected.table_name
      FROM (VALUES ('scada_alarms'), ('scada_alarm_chronicle'), ('scada_tag_history')) AS expected(table_name)
      WHERE NOT EXISTS (
        SELECT 1
        FROM information_schema.tables t
        WHERE t.table_schema = 'sensor'
          AND t.table_name = expected.table_name
          AND t.table_type = 'BASE TABLE'
      )
      ORDER BY expected.table_name
      `,
    );
    const missingRows = Array.isArray(rows) ? (rows as readonly unknown[]) : [];
    if (missingRows.length > 0) {
      const missing = missingRows.map((row) => {
        const tableName =
          typeof row === 'object' && row !== null
            ? (row as Record<string, unknown>).table_name
            : undefined;
        return `sensor.${typeof tableName === 'string' ? tableName : String(tableName)}`;
      });
      throw new Error(`SCADA alarm storage table(s) missing: ${missing.join(', ')}`);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Coalesced per-tenant write (tenant-context, RLS-enforced)         */
  /* ---------------------------------------------------------------- */

  /**
   * Apply a tenant's whole coalesced write batch in ONE tenant-context
   * transaction. `runInTenantTransaction` sets `app.current_tenant` so the
   * FORCED `tenant_isolation_policy` ENFORCES every row (a wrong tenant_id is
   * refused by Postgres, not silently written). Batched multi-row statements
   * keep the 1 Hz loop off a per-write transaction storm.
   */
  async flushTenantBatch(tenantId: string, batch: ScadaAlarmWriteBatch): Promise<void> {
    this.assertTenant(tenantId);
    if (
      batch.upserts.length === 0 &&
      batch.chronicles.length === 0 &&
      batch.deleteIds.length === 0
    ) {
      return;
    }

    await runInTenantTransaction(this.dataSource, SENSOR_SCHEMA, tenantId, async (qr) => {
      if (batch.upserts.length > 0) {
        await this.upsertAlarmsBatch(qr, tenantId, batch.upserts);
      }
      if (batch.chronicles.length > 0) {
        await this.insertChronicleBatch(qr, tenantId, batch.chronicles);
      }
      if (batch.deleteIds.length > 0) {
        // RLS USING already fences to current_tenant; the explicit tenant_id
        // predicate is defence-in-depth.
        await qr.query(`DELETE FROM scada_alarms WHERE id = ANY($1) AND tenant_id = $2`, [
          batch.deleteIds,
          tenantId,
        ]);
      }
    });
  }

  /** Multi-row upsert of active alarms (deduped by id upstream). */
  private async upsertAlarmsBatch(
    qr: QueryRunner,
    tenantId: string,
    alarms: ScadaAlarm[],
  ): Promise<void> {
    const rows: string[] = [];
    const params: unknown[] = [];
    let pi = 1;
    for (const a of alarms) {
      // 16 bound params per row; updated_at is NOW().
      rows.push(
        `($${pi},$${pi + 1},$${pi + 2},$${pi + 3},$${pi + 4},$${pi + 5},$${pi + 6},$${pi + 7},` +
          `$${pi + 8},$${pi + 9},$${pi + 10},$${pi + 11},$${pi + 12},$${pi + 13},$${pi + 14},$${pi + 15},NOW())`,
      );
      params.push(
        tenantId,
        a.id,
        a.ruleId,
        a.ruleName,
        a.severity,
        a.status,
        a.message,
        a.group ?? null,
        a.currentValue,
        a.threshold,
        a.onTime,
        a.offTime ?? null,
        a.ackTime ?? null,
        a.ackUserId ?? null,
        a.colors?.background ?? null,
        a.colors?.text ?? null,
      );
      pi += 16;
    }

    await qr.query(
      `
      INSERT INTO scada_alarms
        (tenant_id, id, rule_id, rule_name, severity, status, message, group_name,
         current_value, threshold, on_time, off_time, ack_time, ack_user_id,
         colors_bg, colors_text, updated_at)
      VALUES ${rows.join(', ')}
      ON CONFLICT (id) DO UPDATE SET
        severity      = EXCLUDED.severity,
        status        = EXCLUDED.status,
        message       = EXCLUDED.message,
        current_value = EXCLUDED.current_value,
        off_time      = EXCLUDED.off_time,
        ack_time      = EXCLUDED.ack_time,
        ack_user_id   = EXCLUDED.ack_user_id,
        colors_bg     = EXCLUDED.colors_bg,
        colors_text   = EXCLUDED.colors_text,
        updated_at    = NOW()
      `,
      params,
    );
  }

  /** Multi-row append to the chronicle (append-only, idempotent on id). */
  private async insertChronicleBatch(
    qr: QueryRunner,
    tenantId: string,
    chronicles: ScadaAlarmChronicle[],
  ): Promise<void> {
    const rows: string[] = [];
    const params: unknown[] = [];
    let pi = 1;
    for (const c of chronicles) {
      rows.push(
        `($${pi},$${pi + 1},$${pi + 2},$${pi + 3},$${pi + 4},$${pi + 5},$${pi + 6},$${pi + 7},` +
          `$${pi + 8},$${pi + 9},$${pi + 10},$${pi + 11},$${pi + 12},$${pi + 13})`,
      );
      params.push(
        tenantId,
        c.id,
        c.ruleId,
        c.ruleName,
        c.severity,
        c.status,
        c.message,
        c.group ?? null,
        c.currentValue,
        c.threshold,
        c.onTime,
        c.offTime ?? null,
        c.ackTime ?? null,
        c.ackUserId ?? null,
      );
      pi += 14;
    }

    await qr.query(
      `
      INSERT INTO scada_alarm_chronicle
        (tenant_id, id, rule_id, rule_name, severity, status, message, group_name,
         current_value, threshold, on_time, off_time, ack_time, ack_user_id)
      VALUES ${rows.join(', ')}
      ON CONFLICT (id) DO NOTHING
      `,
      params,
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Active alarm read                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Return all active alarms for `tenantId`. Runs in a tenant-context read
   * transaction so the FORCED RLS policy admits exactly this tenant's rows.
   */
  async getActiveAlarms(tenantId: string): Promise<AlarmInstance[]> {
    this.assertTenant(tenantId);
    try {
      const rows: AlarmRow[] = await runInTenantRead(
        this.dataSource,
        SENSOR_SCHEMA,
        tenantId,
        (qr) =>
          qr.query(
            `
            SELECT * FROM scada_alarms
            WHERE tenant_id = $1
            ORDER BY
              CASE severity
                WHEN 'critical' THEN 1
                WHEN 'high'     THEN 2
                WHEN 'warning'  THEN 3
                WHEN 'info'     THEN 4
                ELSE 5
              END,
              on_time ASC
            `,
            [tenantId],
          ),
      );
      return rows.map(rowToInstance);
    } catch (error) {
      this.logger.error(`getActiveAlarms: query failed — ${(error as Error).message}`);
      return [];
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Chronicle read                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Query alarm history for `tenantId` with optional filtering. Runs in a
   * tenant-context read transaction; the tenant fence is both the RLS policy
   * and the leading SQL predicate (defence-in-depth).
   */
  async getAlarmHistory(
    tenantId: string,
    filter: AlarmHistoryFilter = {},
  ): Promise<AlarmInstance[]> {
    this.assertTenant(tenantId);
    try {
      const conditions: string[] = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      let idx = 2;

      if (filter.severity && filter.severity.length > 0) {
        conditions.push(`severity = ANY($${idx})`);
        params.push(filter.severity);
        idx++;
      }

      if (filter.group) {
        conditions.push(`group_name = $${idx}`);
        params.push(filter.group);
        idx++;
      }

      if (filter.textSearch) {
        conditions.push(`(message ILIKE $${idx} OR rule_name ILIKE $${idx})`);
        params.push(`%${filter.textSearch}%`);
        idx++;
      }

      if (filter.tagIds && filter.tagIds.length > 0) {
        conditions.push(`rule_id = ANY($${idx})`);
        params.push(filter.tagIds);
        idx++;
      }

      if (filter.from != null) {
        conditions.push(`on_time >= $${idx}`);
        params.push(filter.from);
        idx++;
      }

      if (filter.to != null) {
        conditions.push(`on_time <= $${idx}`);
        params.push(filter.to);
        idx++;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = filter.limit ?? 500;
      const offset = filter.offset ?? 0;

      const rows: AlarmRow[] = await runInTenantRead(
        this.dataSource,
        SENSOR_SCHEMA,
        tenantId,
        (qr) =>
          qr.query(
            `
            SELECT
              id, rule_id, rule_name, severity, status, message, group_name,
              current_value, threshold, on_time, off_time, ack_time, ack_user_id,
              NULL AS colors_bg, NULL AS colors_text
            FROM scada_alarm_chronicle
            ${where}
            ORDER BY on_time DESC
            LIMIT $${idx} OFFSET $${idx + 1}
            `,
            [...params, limit, offset],
          ),
      );

      return rows.map(rowToInstance);
    } catch (error) {
      this.logger.error(`getAlarmHistory: query failed — ${(error as Error).message}`);
      return [];
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Cross-tenant retention sweep (audited RLS bypass)                 */
  /* ---------------------------------------------------------------- */

  /**
   * Delete chronicle records older than `retentionDays` across ALL tenants.
   *
   * This is a genuinely cross-tenant maintenance sweep with no per-row tenant
   * context — the outbox-worker class — so it runs under the audited
   * `BypassRlsService.withBypass` (the FORCED policy would otherwise match zero
   * rows and retention would silently stall). Bypass is logged at WARN with a
   * greppable label.
   */
  async cleanupHistory(retentionDays: number): Promise<number> {
    if (retentionDays <= 0) {
      throw new RangeError('retentionDays must be a positive integer');
    }
    try {
      const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const deleted = await this.bypassRls.withBypass('scada:cleanup-alarm-chronicle', async () => {
        // pg driver returns [rows, rowCount] for DML.
        const [, affectedRows] = await this.dataSource.query(
          `DELETE FROM scada_alarm_chronicle WHERE on_time < $1`,
          [cutoffMs],
        );
        return typeof affectedRows === 'number' ? affectedRows : 0;
      });
      if (deleted > 0) {
        this.logger.log(
          `cleanupHistory: deleted ${deleted} record(s) older than ${retentionDays} days`,
        );
      }
      return deleted;
    } catch (error) {
      this.logger.error(`cleanupHistory: failed — ${(error as Error).message}`);
      return 0;
    }
  }
}
