/**
 * RetentionEnforcementService — one-service-many-policies retention runner.
 * ============================================================================
 *
 * Replaces per-table retention services with a single scheduled
 * iterator. Reads every registered RetentionPolicy once per day at
 * 03:00 UTC and applies a safe age-based DELETE. Architectural
 * contract:
 *
 *   1. One cron, one service, N policies — adding a new audit table
 *      to the retention regime is a one-line `registerRetentionPolicy`
 *      call at module-init, NOT a new Service + Module + Spec file.
 *
 *   2. Legal-hold predicates travel WITH the policy — see
 *      retention-policy.ts docblock. The enforcer is schema-agnostic.
 *
 *   3. Per-policy delete runs in its OWN try/catch. A failing policy
 *      does NOT stop subsequent policies from executing; the error
 *      is logged per-policy so one broken table doesn't silence the
 *      retention audit trail for ALL tables.
 *
 *   4. DELETE uses parameterised age threshold ($1 = cutoff ISO) +
 *      parameterised legal-hold params ($2..). Table + column
 *      identifiers are inlined from the validated policy fields.
 *
 * # Why explicit identifier inlining instead of binding
 *
 * PG bind parameters cannot be used for identifiers (table names,
 * column names). The policy validates identifiers against
 * SAFE_IDENT_RE at REGISTRATION time — before any runtime query
 * can see them — so inlining is safe in the enforcer.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';

import { listRetentionPolicies, type RetentionPolicy } from './retention-policy';

export interface RetentionQueryExecutor {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

export interface RetentionEnforcementReport {
  readonly policyId: string;
  readonly ownerTag: string;
  readonly schema: string;
  readonly tableName: string;
  readonly cutoffIso: string;
  readonly deleted: number;
  readonly error?: string;
}

@Injectable()
export class RetentionEnforcementService {
  private readonly logger = new Logger(RetentionEnforcementService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: RetentionQueryExecutor,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async enforceAll(): Promise<readonly RetentionEnforcementReport[]> {
    return this.enforceAllOnce();
  }

  /**
   * Public entry for tests + operator manual invocation. Passes a
   * NOW override so specs can time-travel without waiting for
   * actual wall-clock cron ticks.
   */
  async enforceAllOnce(now: Date = new Date()): Promise<readonly RetentionEnforcementReport[]> {
    const policies = listRetentionPolicies();
    if (policies.length === 0) {
      this.logger.debug('No retention policies registered; noop.');
      return [];
    }
    const reports: RetentionEnforcementReport[] = [];
    for (const p of policies) {
      // Per-policy try/catch: one broken table MUST NOT stall the
      // rest of the retention audit trail for the cycle.
      try {
        const deleted = await this.enforceOne(p, now);
        const cutoffIso = this.cutoffFor(p, now).toISOString();
        this.logger.log(
          `retention [${p.id}] owner=${p.ownerTag} ${p.schema}.${p.tableName} — ` +
            `deleted=${deleted} cutoff=${cutoffIso}`,
        );
        reports.push({
          policyId: p.id,
          ownerTag: p.ownerTag,
          schema: p.schema,
          tableName: p.tableName,
          cutoffIso,
          deleted,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`retention [${p.id}] FAILED: ${msg}. Subsequent policies continue.`);
        reports.push({
          policyId: p.id,
          ownerTag: p.ownerTag,
          schema: p.schema,
          tableName: p.tableName,
          cutoffIso: this.cutoffFor(p, now).toISOString(),
          deleted: 0,
          error: msg,
        });
      }
    }
    return reports;
  }

  /**
   * Single-policy entry point — exported for specs + potential
   * per-policy operator triggers. The enforcer is idempotent under
   * repeated calls (same NOW → same cutoff → same deletion set;
   * already-deleted rows contribute 0 on the second call).
   */
  async enforceOne(p: RetentionPolicy, now: Date = new Date()): Promise<number> {
    const cutoff = this.cutoffFor(p, now);
    const quotedSchema = `"${p.schema}"`;
    const quotedTable = `"${p.tableName}"`;
    const quotedCol = `"${p.timestampColumn}"`;
    const baseWhere = `${quotedCol} < $1`;
    const legalHold = p.legalHoldClause ? ` AND NOT (${p.legalHoldClause})` : '';
    // RETURNING 1 — same pattern as backfillColumn. TypeORM's
    // PostgresQueryRunner.query returns the result rows array;
    // rows.length is the portable row-count observation.
    const sql =
      `DELETE FROM ${quotedSchema}.${quotedTable} ` +
      `WHERE ${baseWhere}${legalHold} ` +
      `RETURNING 1`;
    const params: unknown[] = [cutoff.toISOString()];
    if (p.legalHoldParams && p.legalHoldParams.length > 0) {
      for (const v of p.legalHoldParams) params.push(v);
    }
    const result: unknown = await this.dataSource.query(sql, params);
    if (Array.isArray(result)) return result.length;
    return 0;
  }

  private cutoffFor(p: RetentionPolicy, now: Date): Date {
    if (p.retentionDays !== undefined) {
      return new Date(now.getTime() - p.retentionDays * 86_400_000);
    }

    const match = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?$/.exec(p.retentionPeriod);
    if (!match) {
      throw new RangeError(`Invalid registered retention period: ${p.retentionPeriod}`);
    }

    const years = Number(match[1] ?? 0);
    const months = Number(match[2] ?? 0);
    const days = Number(match[3] ?? 0);
    const cutoff = new Date(now.getTime());
    const originalDay = cutoff.getUTCDate();

    cutoff.setUTCDate(1);
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
    const lastDayOfTargetMonth = new Date(
      Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0),
    ).getUTCDate();
    cutoff.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth));
    cutoff.setUTCDate(cutoff.getUTCDate() - days);
    return cutoff;
  }
}
