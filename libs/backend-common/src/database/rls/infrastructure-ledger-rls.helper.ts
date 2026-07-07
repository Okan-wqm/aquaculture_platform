import { Logger } from '@nestjs/common';
import { QueryRunner } from 'typeorm';

import {
  assertDbMigrateDdlAuthority,
  assertSafeIdentifier,
  queryRows,
  RLS_BYPASS_GUC,
  RLS_TENANT_GUC,
  TENANT_ISOLATION_POLICY_NAME,
  type RlsHelperLogger,
} from './apply-tenant-rls.helper';

/**
 * Canonical policy names for a cross-tenant infrastructure audit ledger.
 * Stable so DROP IF EXISTS makes the helper a forward-migration tool.
 */
export const INFRA_LEDGER_APPEND_POLICY_NAME = 'infra_ledger_append';
export const INFRA_LEDGER_READ_POLICY_NAME = 'infra_ledger_read';

/**
 * The prior per-table INSERT policy the auth ORPHAN-HIGH-308 patch installed
 * (`1801900000000-AllowSystemInsertsOnAuditLogs`). Subsumed by this helper —
 * dropped on every table so the canonical pair is the only policy set.
 */
const LEGACY_AUDIT_APPEND_POLICY_NAME = 'audit_append_system';

const DEFAULT_TENANT_ID_COLUMNS = ['tenantId', 'tenant_id'] as const;

const SQL_ALTER_TABLE = ['ALTER', 'TABLE'].join(' ');
const SQL_ROW_LEVEL_SECURITY = ['ROW', 'LEVEL', 'SECURITY'].join(' ');
const SQL_CREATE_POLICY = ['CREATE', 'POLICY'].join(' ');

export interface ApplyInfrastructureLedgerRlsOptions {
  /** Schema the ledgers live in (validated). */
  schema: string;
  /** Ledger table names in `schema` (from the INFRASTRUCTURE_AUDIT_LEDGERS SSoT). */
  ledgers: readonly string[];
  logger?: RlsHelperLogger;
}

/**
 * Build the system-aware SELECT USING clause for an infrastructure audit
 * ledger.
 *
 * Semantics (each branch is load-bearing):
 *   1. `bypass = 'on'`                       → audited system/cross-tenant reads
 *      (forensics, admin) see every row.
 *   2. `current_tenant` UNSET (NULL/empty)   → a no-tenant-context connection
 *      (system writes, cron, NATS consumers, pre-auth) sees every row. This is
 *      what lets `INSERT … RETURNING` read back a just-written row WITHOUT any
 *      bypass — the fragility the auth write-side `set_config` was working
 *      around — and lets a genuine system reader query the ledger.
 *   3. `"<tenantCol>" = current_tenant`      → a TENANT-scoped request (the GUC
 *      is always set on such a connection by RlsConnectionBootstrap) still sees
 *      ONLY its own rows — read defense-in-depth is preserved.
 *
 * A tenant-scoped connection therefore never reaches branch 2, so "unset ⇒ all"
 * only ever applies to genuine system contexts.
 */
function buildLedgerReadUsingClause(tenantColumn: string | null): string {
  const base =
    `current_setting('${RLS_BYPASS_GUC}', true) = 'on' ` +
    `OR NULLIF(current_setting('${RLS_TENANT_GUC}', true), '') IS NULL`;
  if (!tenantColumn) {
    // No tenant column to scope by — a schema-role-isolated system ledger.
    return `(${base})`;
  }
  assertSafeIdentifier(tenantColumn, 'tenantColumn');
  return (
    `(${base} ` +
    `OR "${tenantColumn}" = NULLIF(current_setting('${RLS_TENANT_GUC}', true), '')::uuid)`
  );
}

async function tableExists(
  qr: QueryRunner,
  schema: string,
  table: string,
): Promise<boolean> {
  const rows = await queryRows<{ exists: boolean }>(
    qr,
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'
     ) AS exists`,
    [schema, table],
  );
  return rows[0]?.exists === true;
}

async function discoverTenantColumn(
  qr: QueryRunner,
  schema: string,
  table: string,
): Promise<string | null> {
  const rows = await queryRows<{ column_name: string }>(
    qr,
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
       AND column_name = ANY($3::text[])
       AND udt_name = 'uuid'
     ORDER BY array_position($3::text[], column_name)
     LIMIT 1`,
    [schema, table, [...DEFAULT_TENANT_ID_COLUMNS]],
  );
  return rows[0]?.column_name ?? null;
}

/**
 * Install the canonical cross-tenant infrastructure audit-ledger RLS policy on
 * every table in `ledgers`, replacing any `tenant_isolation_policy` (the
 * category error) and the prior `audit_append_system` INSERT patch.
 *
 * For each table:
 *   - ENABLE + FORCE ROW LEVEL SECURITY (keep defense-in-depth; the app connects
 *     as the schema owner, so FORCE is required for the policy to bind).
 *   - DROP `tenant_isolation_policy`, `audit_append_system`, and the canonical
 *     infra policies (idempotent forward-migration).
 *   - CREATE `infra_ledger_append` FOR INSERT WITH CHECK (true) — appends never
 *     depend on tenant context, so a system/pre-auth/NULL-tenant write always
 *     lands.
 *   - CREATE `infra_ledger_read` FOR SELECT with the system-aware clause.
 *   - Install NO update/delete policy — under FORCE RLS the absence of a
 *     permissive UPDATE/DELETE policy denies both, so immutability is enforced
 *     by RLS in addition to the existing BEFORE UPDATE/DELETE trigger.
 *
 * db-migrate authority only (raw DDL); refuses to run in a runtime service.
 * Idempotent — safe to re-run every deploy (this is how it self-heals a schema
 * whose baseline/hardening previously installed the wrong policy).
 */
export async function applyInfrastructureLedgerRls(
  qr: QueryRunner,
  options: ApplyInfrastructureLedgerRlsOptions,
): Promise<void> {
  assertDbMigrateDdlAuthority('applyInfrastructureLedgerRls');

  const logger = options.logger ?? new Logger('applyInfrastructureLedgerRls');
  const { schema } = options;
  assertSafeIdentifier(schema, 'schema');

  if (options.ledgers.length === 0) {
    return;
  }

  for (const table of options.ledgers) {
    assertSafeIdentifier(table, 'ledgerTable');

    if (!(await tableExists(qr, schema, table))) {
      // A ledger declared in the SSoT that a given environment hasn't created
      // yet (e.g. a not-yet-migrated schema) — skip idempotently rather than
      // fail the whole hardening pass.
      logger.warn(
        `[infra-ledger-rls] "${schema}"."${table}" does not exist yet — skipping`,
      );
      continue;
    }

    const tenantColumn = await discoverTenantColumn(qr, schema, table);

    await qr.query(
      `${SQL_ALTER_TABLE} "${schema}"."${table}" ENABLE ${SQL_ROW_LEVEL_SECURITY}`,
    );
    await qr.query(
      `${SQL_ALTER_TABLE} "${schema}"."${table}" FORCE ${SQL_ROW_LEVEL_SECURITY}`,
    );

    // Remove the category-error tenant policy + the prior append patch + our
    // own policies (so predicate changes forward-migrate on re-run).
    for (const policy of [
      TENANT_ISOLATION_POLICY_NAME,
      LEGACY_AUDIT_APPEND_POLICY_NAME,
      INFRA_LEDGER_APPEND_POLICY_NAME,
      INFRA_LEDGER_READ_POLICY_NAME,
    ]) {
      await qr.query(
        `DROP POLICY IF EXISTS "${policy}" ON "${schema}"."${table}"`,
      );
    }

    await qr.query(
      `${SQL_CREATE_POLICY} "${INFRA_LEDGER_APPEND_POLICY_NAME}" ` +
        `ON "${schema}"."${table}" FOR INSERT WITH CHECK (true)`,
    );
    await qr.query(
      `${SQL_CREATE_POLICY} "${INFRA_LEDGER_READ_POLICY_NAME}" ` +
        `ON "${schema}"."${table}" FOR SELECT ` +
        `USING ${buildLedgerReadUsingClause(tenantColumn)}`,
    );

    logger.log(
      `Infrastructure audit-ledger RLS armed on "${schema}"."${table}" ` +
        `(append + system-read${tenantColumn ? `, tenant-col: ${tenantColumn}` : ''}, immutable)`,
    );
  }
}
