/**
 * Platform-wide invariant — AUDITTRAIL-CRITICAL-001 / DBR-CRITICAL-001 /
 * MT-CRITICAL-005 / COMPLIANCE-CRITICAL-001 / LEGAL-HIGH-001:
 *
 * The two immutability triggers + the `legalHold` column on
 * `shared.audit_logs` MUST be installed by an active migration.
 *
 * # Why
 *
 * On 2026-04 the migration `1787200000000-RealignSharedAuditLogsSchema`
 * silently dropped the immutability triggers and the legalHold column
 * by issuing `DROP TABLE shared.audit_logs CASCADE` and recreating the
 * table with the canonical 14-column shape — without re-attaching the
 * triggers or the legalHold column. Audit-row UPDATEs and DELETEs
 * became permissible at the database level on every service writing
 * to the cross-service audit trail.
 *
 * Restoration shipped in `1787400000000-RestoreSharedAuditLogsImmutability`.
 * This invariant prevents a future migration from re-introducing the
 * regression class. The check is source-level: the most recent migration
 * that touches `shared.audit_logs` (by string match) MUST declare the
 * three artefacts (legalHold column + 2 trigger functions + 2 trigger
 * objects) OR be a no-op idempotency-check migration. The shape is
 * specific enough that any future maintainer dropping the protections
 * will fail this gate at CI.
 *
 * # Allowed shapes
 *
 *  1. `1787400000000-RestoreSharedAuditLogsImmutability` — installs all 3.
 *  2. Any later migration may CASCADE-drop the table only if it ALSO
 *     re-installs all 3 artefacts in the same `up()`. The required
 *     substrings are checked together.
 *
 * # Why this lives in tests/invariants/
 *
 * The audit-immutability regression is the kind of defect a code-only
 * review easily misses — the migration in question landed cleanly; the
 * trigger drop was implicit in CASCADE. A specific, narrow invariant
 * is the right tier-3 (make-detectable) hedge.
 */

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { WORM_LEDGERS } from '../../libs/backend-common/src/constants/protected-tables';
import {
  auditImmutabilityNames,
  auditImmutabilityStatements,
} from '../../libs/backend-common/src/database/audit-immutability.sql';
import { migrationCorpus, migrationSource, servicesWithMigrations } from './lib/migration-corpus';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ENTITY_PATH = 'libs/backend-common/src/audit/audit-log.entity.ts';
/**
 * The three services that own an audit table. Named as SERVICES, not as globs:
 * the glob form here was `apps/<svc>/src/migrations/*.ts`, and a git pathspec
 * `*` crosses `/`, so it swept in `.archive/` — 55 retired files across the
 * repo, none of which the runtime applies. The 2026-05-18 squash then
 * re-expressed these triggers inline in each Baseline, and this spec kept
 * matching the pre-squash `ALTER TABLE … ADD COLUMN` spelling against a corpus
 * that also contained the pre-squash files. See ORPHAN-CRITICAL-516.
 */
const AUDIT_TABLE_SERVICES = ['admin-api-service', 'auth-service', 'farm-service'] as const;

const REQUIRED_TRIGGER_NAMES = [
  'trg_audit_logs_prevent_update',
  'trg_audit_logs_prevent_legal_hold_delete',
] as const;

const REQUIRED_FUNCTION_NAMES_SHARED = [
  'shared.audit_logs_prevent_update',
  'shared.audit_logs_prevent_legal_hold_delete',
] as const;

const REQUIRED_FUNCTION_NAMES_AUTH = [
  'auth.audit_logs_prevent_update',
  'auth.audit_logs_prevent_legal_hold_delete',
] as const;

// AUDITTRAIL-HIGH-005 farm-side cure (migration 1788300000000): the
// per-tenant farm.farm_audit_logs table needs the same defense-in-depth
// triggers + legalHold column as shared/auth audit tables.
const REQUIRED_FUNCTION_NAMES_FARM = [
  'farm.farm_audit_logs_prevent_update',
  'farm.farm_audit_logs_prevent_legal_hold_delete',
] as const;

const REQUIRED_TRIGGER_NAMES_FARM = [
  'trg_farm_audit_logs_prevent_update',
  'trg_farm_audit_logs_prevent_legal_hold_delete',
] as const;

// AUDITTRAIL-HIGH-006 admin-side cure (migration 1787800000000): the
// SUPER_ADMIN cross-tenant audit table needs the same defense-in-depth
// triggers + legalHold column.
const REQUIRED_FUNCTION_NAMES_ADMIN = [
  'admin.audit_logs_prevent_update',
  'admin.audit_logs_prevent_legal_hold_delete',
] as const;

function loadMigrationCorpus(): string {
  // Was a private reimplementation of exactly this, one of eight in the repo.
  // The shared module derives each service's migrations directory from its own
  // data-source.ts, so it cannot read a retired migration as evidence.
  return migrationSource(...AUDIT_TABLE_SERVICES);
}

describe('INVARIANT (AUDITTRAIL-CRITICAL-001 / AUDITTRAIL-HIGH-005): audit-table immutability artefacts', () => {
  it('AuditLogEntity (shared) declares the legalHold column', () => {
    const entitySrc = readFileSync(resolve(REPO_ROOT, ENTITY_PATH), 'utf8');

    // The column declaration must be present so SchemaDriftValidator
    // catches any future migration that drops the underlying column.
    expect(entitySrc).toMatch(/legalHold!:\s*boolean/);
    expect(entitySrc).toMatch(/@Column\(\s*\{[^}]*type:\s*'boolean'/);
  });

  it('AuditLog entity (auth) declares the legalHold column', () => {
    const entitySrc = readFileSync(
      resolve(REPO_ROOT, 'apps/auth-service/src/audit/audit-log.entity.ts'),
      'utf8',
    );
    expect(entitySrc).toMatch(/legalHold!:\s*boolean/);
    expect(entitySrc).toMatch(/@Column\(\s*\{[^}]*type:\s*'boolean'/);
  });

  it('shared.audit_logs carries the append-only contract, and a migration applies it', () => {
    // TWO PROPERTIES, ASSERTED SEPARATELY, because the SQL is generated.
    //
    // This used to regex the migration SOURCE for `CREATE OR REPLACE FUNCTION
    // shared.audit_logs_prevent_update(`. That worked while every audit table
    // carried its own hand-written copy — which is precisely how the
    // 2026-05-18 baseline came to hand-author a FIFTH variant that collapsed
    // both triggers into one unconditional UPDATE-OR-DELETE refusal, dropping
    // the legal-hold distinction and, for shared.audit_logs, the protection
    // entirely (ORPHAN-CRITICAL-517). The SQL now comes from one generator, so
    // grepping migration text would assert nothing about what runs.
    //
    // 1. The contract itself: the generator emits the two functions and the two
    //    triggers, with the DELETE guard conditional on legalHold rather than
    //    unconditional. This is the half the squash got wrong.
    const statements = auditImmutabilityStatements({ schema: 'shared', table: 'audit_logs' }).join(
      '\n',
    );
    const names = auditImmutabilityNames({ schema: 'shared', table: 'audit_logs' });

    expect(statements).toMatch(
      new RegExp(
        `CREATE OR REPLACE FUNCTION\\s+${names.updateFunction.replace('.', '\\.')}\\s*\\(`,
        'i',
      ),
    );
    expect(statements).toMatch(
      new RegExp(
        `CREATE OR REPLACE FUNCTION\\s+${names.deleteFunction.replace('.', '\\.')}\\s*\\(`,
        'i',
      ),
    );
    expect(statements).toMatch(
      new RegExp(
        `CREATE TRIGGER\\s+${names.updateTrigger}\\s+BEFORE UPDATE ON\\s+"shared"\\."audit_logs"`,
        'i',
      ),
    );
    expect(statements).toMatch(
      new RegExp(
        `CREATE TRIGGER\\s+${names.deleteTrigger}\\s+BEFORE DELETE ON\\s+"shared"\\."audit_logs"`,
        'i',
      ),
    );
    // The distinction the baseline lost: DELETE is refused only under hold.
    expect(statements).toMatch(/IF OLD\."legalHold" = true THEN/);
    expect(statements).toMatch(/RETURN OLD;/);

    // 2. The wiring: some migration the owning service ACTUALLY APPLIES calls
    //    the generator for this table. A correct generator nobody invokes is
    //    the ORPHAN-HIGH-455 shape, and it is what this half exists to catch.
    const applied = migrationCorpus('admin-api-service').source;
    expect(applied).toContain('auditImmutabilityStatements');
    expect(applied).toMatch(new RegExp(`schema:\\s*'shared'\\s*,\\s*table:\\s*'audit_logs'`));
  });

  it('auth.audit_logs carries the append-only contract, and a migration applies it', () => {
    // TWO PROPERTIES, ASSERTED SEPARATELY, because the SQL is generated.
    //
    // This used to regex the migration SOURCE for `CREATE OR REPLACE FUNCTION
    // auth.audit_logs_prevent_update(`. That worked while every audit table
    // carried its own hand-written copy — which is precisely how the
    // 2026-05-18 baseline came to hand-author a FIFTH variant that collapsed
    // both triggers into one unconditional UPDATE-OR-DELETE refusal, dropping
    // the legal-hold distinction and, for shared.audit_logs, the protection
    // entirely (ORPHAN-CRITICAL-517). The SQL now comes from one generator, so
    // grepping migration text would assert nothing about what runs.
    //
    // 1. The contract itself: the generator emits the two functions and the two
    //    triggers, with the DELETE guard conditional on legalHold rather than
    //    unconditional. This is the half the squash got wrong.
    const statements = auditImmutabilityStatements({ schema: 'auth', table: 'audit_logs' }).join(
      '\n',
    );
    const names = auditImmutabilityNames({ schema: 'auth', table: 'audit_logs' });

    expect(statements).toMatch(
      new RegExp(
        `CREATE OR REPLACE FUNCTION\\s+${names.updateFunction.replace('.', '\\.')}\\s*\\(`,
        'i',
      ),
    );
    expect(statements).toMatch(
      new RegExp(
        `CREATE OR REPLACE FUNCTION\\s+${names.deleteFunction.replace('.', '\\.')}\\s*\\(`,
        'i',
      ),
    );
    expect(statements).toMatch(
      new RegExp(
        `CREATE TRIGGER\\s+${names.updateTrigger}\\s+BEFORE UPDATE ON\\s+"auth"\\."audit_logs"`,
        'i',
      ),
    );
    expect(statements).toMatch(
      new RegExp(
        `CREATE TRIGGER\\s+${names.deleteTrigger}\\s+BEFORE DELETE ON\\s+"auth"\\."audit_logs"`,
        'i',
      ),
    );
    // The distinction the baseline lost: DELETE is refused only under hold.
    expect(statements).toMatch(/IF OLD\."legalHold" = true THEN/);
    expect(statements).toMatch(/RETURN OLD;/);

    // 2. The wiring: some migration the owning service ACTUALLY APPLIES calls
    //    the generator for this table. A correct generator nobody invokes is
    //    the ORPHAN-HIGH-455 shape, and it is what this half exists to catch.
    const applied = migrationCorpus('auth-service').source;
    expect(applied).toContain('auditImmutabilityStatements');
    expect(applied).toMatch(new RegExp(`schema:\\s*'auth'\\s*,\\s*table:\\s*'audit_logs'`));
  });

  it('AuditLog entity (farm) declares the legalHold column', () => {
    const entitySrc = readFileSync(
      resolve(REPO_ROOT, 'apps/farm-service/src/database/entities/audit-log.entity.ts'),
      'utf8',
    );
    expect(entitySrc).toMatch(/legalHold!:\s*boolean/);
    expect(entitySrc).toMatch(/@Column\(\s*\{[^}]*type:\s*'boolean'/);
  });

  it('farm.farm_audit_logs carries the append-only contract, and a migration applies it', () => {
    // TWO PROPERTIES, ASSERTED SEPARATELY, because the SQL is generated.
    //
    // This used to regex the migration SOURCE for `CREATE OR REPLACE FUNCTION
    // farm.farm_audit_logs_prevent_update(`. That worked while every audit table
    // carried its own hand-written copy — which is precisely how the
    // 2026-05-18 baseline came to hand-author a FIFTH variant that collapsed
    // both triggers into one unconditional UPDATE-OR-DELETE refusal, dropping
    // the legal-hold distinction and, for shared.audit_logs, the protection
    // entirely (ORPHAN-CRITICAL-517). The SQL now comes from one generator, so
    // grepping migration text would assert nothing about what runs.
    //
    // 1. The contract itself: the generator emits the two functions and the two
    //    triggers, with the DELETE guard conditional on legalHold rather than
    //    unconditional. This is the half the squash got wrong.
    const statements = auditImmutabilityStatements({
      schema: 'farm',
      table: 'farm_audit_logs',
    }).join('\n');
    const names = auditImmutabilityNames({ schema: 'farm', table: 'farm_audit_logs' });

    expect(statements).toMatch(
      new RegExp(
        `CREATE OR REPLACE FUNCTION\\s+${names.updateFunction.replace('.', '\\.')}\\s*\\(`,
        'i',
      ),
    );
    expect(statements).toMatch(
      new RegExp(
        `CREATE OR REPLACE FUNCTION\\s+${names.deleteFunction.replace('.', '\\.')}\\s*\\(`,
        'i',
      ),
    );
    expect(statements).toMatch(
      new RegExp(
        `CREATE TRIGGER\\s+${names.updateTrigger}\\s+BEFORE UPDATE ON\\s+"farm"\\."farm_audit_logs"`,
        'i',
      ),
    );
    expect(statements).toMatch(
      new RegExp(
        `CREATE TRIGGER\\s+${names.deleteTrigger}\\s+BEFORE DELETE ON\\s+"farm"\\."farm_audit_logs"`,
        'i',
      ),
    );
    // The distinction the baseline lost: DELETE is refused only under hold.
    expect(statements).toMatch(/IF OLD\."legalHold" = true THEN/);
    expect(statements).toMatch(/RETURN OLD;/);

    // 2. The wiring: some migration the owning service ACTUALLY APPLIES calls
    //    the generator for this table. A correct generator nobody invokes is
    //    the ORPHAN-HIGH-455 shape, and it is what this half exists to catch.
    const applied = migrationCorpus('farm-service').source;
    expect(applied).toContain('auditImmutabilityStatements');
    expect(applied).toMatch(new RegExp(`schema:\\s*'farm'\\s*,\\s*table:\\s*'farm_audit_logs'`));
  });

  it('AuditLog entity (admin) declares the legalHold column', () => {
    const entitySrc = readFileSync(
      resolve(REPO_ROOT, 'apps/admin-api-service/src/audit/audit.entity.ts'),
      'utf8',
    );
    expect(entitySrc).toMatch(/legalHold!:\s*boolean/);
    expect(entitySrc).toMatch(/@Column\(\s*\{[^}]*type:\s*'boolean'/);
  });

  it('admin.audit_logs carries the append-only contract, and a migration applies it', () => {
    // TWO PROPERTIES, ASSERTED SEPARATELY, because the SQL is generated.
    //
    // This used to regex the migration SOURCE for `CREATE OR REPLACE FUNCTION
    // admin.audit_logs_prevent_update(`. That worked while every audit table
    // carried its own hand-written copy — which is precisely how the
    // 2026-05-18 baseline came to hand-author a FIFTH variant that collapsed
    // both triggers into one unconditional UPDATE-OR-DELETE refusal, dropping
    // the legal-hold distinction and, for shared.audit_logs, the protection
    // entirely (ORPHAN-CRITICAL-517). The SQL now comes from one generator, so
    // grepping migration text would assert nothing about what runs.
    //
    // 1. The contract itself: the generator emits the two functions and the two
    //    triggers, with the DELETE guard conditional on legalHold rather than
    //    unconditional. This is the half the squash got wrong.
    const statements = auditImmutabilityStatements({ schema: 'admin', table: 'audit_logs' }).join(
      '\n',
    );
    const names = auditImmutabilityNames({ schema: 'admin', table: 'audit_logs' });

    expect(statements).toMatch(
      new RegExp(
        `CREATE OR REPLACE FUNCTION\\s+${names.updateFunction.replace('.', '\\.')}\\s*\\(`,
        'i',
      ),
    );
    expect(statements).toMatch(
      new RegExp(
        `CREATE OR REPLACE FUNCTION\\s+${names.deleteFunction.replace('.', '\\.')}\\s*\\(`,
        'i',
      ),
    );
    expect(statements).toMatch(
      new RegExp(
        `CREATE TRIGGER\\s+${names.updateTrigger}\\s+BEFORE UPDATE ON\\s+"admin"\\."audit_logs"`,
        'i',
      ),
    );
    expect(statements).toMatch(
      new RegExp(
        `CREATE TRIGGER\\s+${names.deleteTrigger}\\s+BEFORE DELETE ON\\s+"admin"\\."audit_logs"`,
        'i',
      ),
    );
    // The distinction the baseline lost: DELETE is refused only under hold.
    expect(statements).toMatch(/IF OLD\."legalHold" = true THEN/);
    expect(statements).toMatch(/RETURN OLD;/);

    // 2. The wiring: some migration the owning service ACTUALLY APPLIES calls
    //    the generator for this table. A correct generator nobody invokes is
    //    the ORPHAN-HIGH-455 shape, and it is what this half exists to catch.
    const applied = migrationCorpus('admin-api-service').source;
    expect(applied).toContain('auditImmutabilityStatements');
    expect(applied).toMatch(new RegExp(`schema:\\s*'admin'\\s*,\\s*table:\\s*'audit_logs'`));
  });

  it('no effective migration offers a down() that removes audit immutability', () => {
    // The cost of weak audit posture is paid forever, so a one-line operator
    // rollback is deliberately refused.
    //
    // THE PROPERTY MOVED, THE FILE DID NOT EXIST. This read
    // `1787400000000-RestoreSharedAuditLogsImmutability.ts` by name; the
    // 2026-05-18 squash retired that file to `.archive/`, so the assertion was
    // pinned to a migration the runtime no longer applies. Reading it proved
    // nothing about the schema a fresh database gets — the same false-evidence
    // shape as ORPHAN-CRITICAL-516 one step removed.
    //
    // Asserted over the effective set, and as a PROHIBITION rather than a
    // presence check: the requirement is that nothing in the applied set can
    // drop these triggers on the way down. That survives any future squash,
    // because it does not care which file carries the statement.
    const aggregate = loadMigrationCorpus();

    const droppers = [
      ...aggregate.matchAll(
        /DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?(trg_(?:farm_)?audit_logs_prevent_[a-z_]+)/gi,
      ),
    ].map((match) => match[1]);

    // A drop is legitimate only when it is immediately re-created — the
    // CREATE OR REPLACE / drop-and-recreate idiom a schema change uses. What
    // must not exist is a trigger dropped and left dropped.
    const abandoned = droppers.filter((name) => {
      const recreated = new RegExp(`CREATE TRIGGER\\s+${name}\\b`, 'i');
      return !recreated.test(aggregate);
    });

    expect(abandoned).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ADR-0008 — WORM_LEDGERS is the classification; this block is its gate.
//
// Membership means: write-once at row granularity, physically `id` +
// `legalHold`, canonical two triggers applied by an effective migration, and
// no repository in the fleet that updates or deletes rows of that entity. The
// hand-listed suites above remain for their historical findings; every entry
// below is DERIVED from the registry so a new ledger cannot be added to the
// list without also carrying the contract.
// ---------------------------------------------------------------------------

/** `git grep -l`; exit status 1 means "no match". */
function gitGrepFiles(args: readonly string[]): string[] {
  try {
    // execFileSync, not a shell string: the patterns carry quotes and braces.
    return execFileSync('git', ['-C', REPO_ROOT, 'grep', '-l', ...args], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status === 1) return [];
    throw err;
  }
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
}

interface LedgerEntity {
  readonly path: string;
  readonly className: string;
  readonly source: string;
}

/** The ONE entity class decorated `@Entity('<table>', { schema: '<schema>' })`. */
function ledgerEntity(schema: string, table: string): LedgerEntity {
  const decorator = `@Entity('${table}', { schema: '${schema}' })`;
  // Literal pathspecs (a glob pathspec such as `apps/*/src` must match the
  // WHOLE path in git, so it would match nothing); the src filter is ours.
  const candidates = gitGrepFiles(['-F', '-e', decorator, '--', 'apps', 'libs']).filter(
    (path) =>
      /\/src\//.test(path) &&
      !/(^|\/)(migrations|\.archive|dist)\//.test(path) &&
      path.endsWith('.entity.ts'),
  );
  expect(candidates).toHaveLength(1);
  const path = candidates[0] as string;
  const source = readFileSync(resolve(REPO_ROOT, path), 'utf8');
  // Only THIS class: the file may hold sibling entities with their own
  // lifecycle columns, and a ledger is judged by its own body.
  const afterDecorator = source.slice(source.indexOf(decorator));
  const classEnd = afterDecorator.indexOf('\n}');
  const classBody = classEnd === -1 ? afterDecorator : afterDecorator.slice(0, classEnd + 2);
  const className = /export class (\w+)/.exec(classBody)?.[1];
  expect(className).toBeDefined();
  return { path, className: className as string, source: classBody };
}

/** Repository method calls that mutate or remove existing rows. */
const ROW_MUTATION_CALL =
  /\.(update|delete|remove|softDelete|softRemove|restore|increment|decrement|upsert)\(/;

describe('INVARIANT (ADR-0008): every WORM ledger carries the write-once contract', () => {
  const fleetMigrations = migrationSource(...servicesWithMigrations());

  it('WORM_LEDGERS is non-empty and names the admin security ledgers', () => {
    expect(WORM_LEDGERS.length).toBeGreaterThanOrEqual(4);
    expect(WORM_LEDGERS).toContain('admin.activity_logs');
    expect(WORM_LEDGERS).toContain('admin.tenant_activities');
  });

  describe.each(WORM_LEDGERS.map((qualified) => qualified.split('.') as [string, string]))(
    '%s.%s',
    (schema, table) => {
      const entity = ledgerEntity(schema, table);

      it('declares id + legalHold on the entity', () => {
        expect(entity.source).toMatch(/\bid!:\s*string/);
        expect(entity.source).toMatch(/legalHold!:\s*boolean/);
      });

      it('carries no mutable lifecycle flag (isArchived / archivedAt / updatedAt)', () => {
        expect(stripComments(entity.source)).not.toMatch(/\b(isArchived|archivedAt)\b/);
        expect(stripComments(entity.source)).not.toMatch(/@UpdateDateColumn/);
      });

      it('has the canonical immutability statements applied by an effective migration', () => {
        expect(fleetMigrations).toMatch(
          new RegExp(`schema:\\s*'${schema}'\\s*,\\s*table:\\s*'${table}'`),
        );
        const names = auditImmutabilityNames({ schema, table });
        const statements = auditImmutabilityStatements({ schema, table }).join('\n');
        expect(statements).toContain(`CREATE TRIGGER ${names.updateTrigger}`);
        expect(statements).toContain(`CREATE TRIGGER ${names.deleteTrigger}`);
      });

      it('no repository in the fleet updates or deletes its rows', () => {
        const consumers = gitGrepFiles([
          '-E',
          '-e',
          `Repository<${entity.className}>`,
          '--',
          'apps',
          'libs',
        ]).filter((path) => !path.endsWith('.spec.ts'));
        const offenders: string[] = [];
        for (const path of consumers) {
          const src = stripComments(readFileSync(resolve(REPO_ROOT, path), 'utf8'));
          const bindings = [
            ...src.matchAll(
              new RegExp(
                `(?:readonly|private|public|protected)\\s+(\\w+)\\??:\\s*Repository<${entity.className}>`,
                'g',
              ),
            ),
          ].map((m) => m[1]);
          for (const binding of bindings) {
            const uses = new RegExp(`this\\.${binding}${ROW_MUTATION_CALL.source}`, 'g');
            if (uses.test(src)) offenders.push(`${path} (${binding})`);
            const qb = new RegExp(
              `this\\.${binding}\\.createQueryBuilder\\([^)]*\\)[\\s\\S]{0,200}?\\.(update|delete|softDelete)\\(`,
              'g',
            );
            if (qb.test(src)) offenders.push(`${path} (${binding} via query builder)`);
          }
        }
        expect(offenders).toEqual([]);
      });
    },
  );
});
