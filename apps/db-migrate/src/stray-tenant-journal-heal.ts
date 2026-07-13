/**
 * Stray tenant-schema migration-journal self-heal (ORPHAN-MEDIUM-386).
 * ============================================================================
 *
 * # What this heals
 *
 * Tenant schemas legitimately carry ONE migration journal per TENANT-AWARE
 * source schema (`migrations_farm`, `migrations_sensor`, … — the
 * `tenantMigrationLedgerTable()` names the fan-out records progress in).
 * Any OTHER `migrations_<svc>` table inside a `tenant_<uuid16>` schema is a
 * stray journal: pure migration bookkeeping whose authority lives in the
 * owning service's source schema (`<svc>.migrations`), never tenant data.
 *
 * The live artifact this closes: `tenant_7f6b08ab90e246d3.migrations_auth`
 * (1 row, `Baseline1800000000000`), minted by the retired runtime seeding
 * path — `SchemaManagerService.seedMigrationsHistory` iterated every module
 * a tenant requested (including the platform-level `auth` module from
 * `auth.tenant_modules`) with no tenant-scoped filter, and copied the
 * source ledger into a per-source tenant journal. That path is gone
 * (`createTenantSchema`/`syncTenantSchema` now refuse runtime DDL; every
 * current journal creator is gated on TENANT_AWARE_SCHEMAS), but the stray
 * it left behind makes every release warn "Tenant schema contains tables
 * registered by NO module".
 *
 * # Guard rails (fail-closed by construction)
 *
 *   1. Only tables matching /^migrations_[a-z_]+$/ inside schemas matching
 *      TENANT_SCHEMA_NAME_RE are even considered.
 *   2. Journals of TENANT-AWARE source schemas are NEVER touched — they are
 *      the fan-out's live bookkeeping; dropping one would make the next
 *      deploy re-run the full history against that tenant and crash on
 *      "relation already exists".
 *   3. A candidate is dropped ONLY when its owning source schema still has
 *      its authoritative `migrations` journal — proving the table is a
 *      duplicate journal of a real service, not something we cannot
 *      attribute. Unattributable candidates are kept and logged loudly.
 *
 * Idempotent: a healed database enumerates zero candidates on the next run.
 * Operates on a caller-owned QueryRunner (mirrors orphan-type-reclamation)
 * so it is unit-testable with a scripted mock.
 */
import {
  MIGRATION_LEDGER_TABLE,
  TENANT_AWARE_SCHEMAS,
  TENANT_SCHEMA_NAME_RE,
} from '@aquaculture/backend-common/database';
import type { QueryRunner } from 'typeorm';

/** Structured JSON logger, matching aqua-db-migrate's `log()` shape. */
export type StrayJournalHealLogger = (record: Record<string, unknown>) => void;

/**
 * Per-source tenant journal name pattern. The prefix mirrors
 * `tenantMigrationLedgerTable()` (`migrations_<sourceSchema>`); the suffix
 * charset matches safe source-schema identifiers actually in use
 * (lowercase + underscore, e.g. `event_store`).
 */
const STRAY_JOURNAL_NAME_RE = /^migrations_[a-z_]+$/;
const JOURNAL_PREFIX = 'migrations_';

export type StrayTenantJournalOutcome =
  /** Stray journal dropped; authoritative journal confirmed in the source schema. */
  | 'dropped'
  /** Legitimate fan-out ledger of a tenant-aware source schema — never touched. */
  | 'kept_tenant_aware_ledger'
  /** Owning source schema has no `migrations` journal — provenance unprovable, kept. */
  | 'kept_missing_source_journal';

export interface StrayTenantJournalHealResult {
  tenantSchema: string;
  table: string;
  /** Source schema the journal name attributes the table to. */
  sourceSchema: string;
  outcome: StrayTenantJournalOutcome;
  /** Journal rows (migration names) destroyed by the drop; [] unless dropped. */
  droppedEntries: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function rowsFromQueryResult(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/**
 * Drop stray `migrations_<svc>` journals found inside tenant schemas.
 * Every drop is logged with the exact journal entries destroyed so the
 * deploy log is the audit trail of what bookkeeping was removed.
 */
export async function healStrayTenantMigrationJournals(
  queryRunner: QueryRunner,
  log: StrayJournalHealLogger,
): Promise<StrayTenantJournalHealResult[]> {
  // Session-scoped bounds: this runs on a dedicated control connection
  // outside a transaction; a DROP TABLE blocked by a concurrent lock must
  // not stall the deploy.
  await queryRunner.query(`SET lock_timeout = '2s'`);
  await queryRunner.query(`SET statement_timeout = '30s'`);

  const candidateRows = rowsFromQueryResult(
    await queryRunner.query(
      `SELECT table_schema AS tenant_schema, table_name
         FROM information_schema.tables
        WHERE table_schema ~ '^tenant_[a-f0-9]{16}$'
          AND table_name ~ '^migrations_[a-z_]+$'
        ORDER BY table_schema, table_name`,
    ),
  );

  const results: StrayTenantJournalHealResult[] = [];
  for (const row of candidateRows) {
    const tenantSchema = typeof row['tenant_schema'] === 'string' ? row['tenant_schema'] : '';
    const table = typeof row['table_name'] === 'string' ? row['table_name'] : '';

    // Defense-in-depth: both identifiers are interpolated into SQL below.
    // The enumeration regexes above already constrain them; re-assert here
    // so a driver quirk can never widen the blast radius.
    if (!TENANT_SCHEMA_NAME_RE.test(tenantSchema) || !STRAY_JOURNAL_NAME_RE.test(table)) {
      throw new Error(
        `[db-migrate] Unsafe stray-journal identifier from enumeration: "${tenantSchema}"."${table}"`,
      );
    }

    const sourceSchema = table.slice(JOURNAL_PREFIX.length);

    if (TENANT_AWARE_SCHEMAS.has(sourceSchema)) {
      // The fan-out's live per-tenant ledger — authoritative bookkeeping,
      // not a stray. Recorded in results (so callers/tests see the full
      // classification) but not logged: N tenants x 7 ledgers per release
      // would be pure noise.
      results.push({
        tenantSchema,
        table,
        sourceSchema,
        outcome: 'kept_tenant_aware_ledger',
        droppedEntries: [],
      });
      continue;
    }

    const sourceJournalRows = rowsFromQueryResult(
      await queryRunner.query(
        `SELECT EXISTS (
           SELECT 1
             FROM information_schema.tables
            WHERE table_schema = $1
              AND table_name = $2
         ) AS exists`,
        [sourceSchema, MIGRATION_LEDGER_TABLE],
      ),
    );
    if (sourceJournalRows[0]?.['exists'] !== true) {
      // Cannot prove this is a duplicate journal of a real service —
      // fail closed and leave it for the unknown-table warning + operator.
      results.push({
        tenantSchema,
        table,
        sourceSchema,
        outcome: 'kept_missing_source_journal',
        droppedEntries: [],
      });
      log({
        level: 'warn',
        message:
          'Stray-looking tenant journal kept — owning source schema has no authoritative ' +
          'migrations journal, so provenance cannot be proven. Investigate manually.',
        context: 'DbMigrateStrayJournalHeal',
        tenantSchema,
        table,
        sourceSchema,
      });
      continue;
    }

    const entryRows = rowsFromQueryResult(
      await queryRunner.query(
        `SELECT "name" FROM "${tenantSchema}"."${table}" ORDER BY "timestamp", "name"`,
      ),
    );
    const droppedEntries = entryRows
      .map((entry) => entry['name'])
      .filter((name): name is string => typeof name === 'string');

    await queryRunner.query(`DROP TABLE IF EXISTS "${tenantSchema}"."${table}"`);

    results.push({
      tenantSchema,
      table,
      sourceSchema,
      outcome: 'dropped',
      droppedEntries,
    });
    log({
      level: 'warn',
      message:
        'Stray tenant-schema migration journal dropped — journal bookkeeping only; the ' +
        'authoritative journal lives in the owning source schema (ORPHAN-MEDIUM-386).',
      context: 'DbMigrateStrayJournalHeal',
      tenantSchema,
      table,
      sourceSchema,
      authoritativeJournal: `${sourceSchema}.${MIGRATION_LEDGER_TABLE}`,
      droppedEntryCount: droppedEntries.length,
      droppedEntries,
    });
  }

  return results;
}
