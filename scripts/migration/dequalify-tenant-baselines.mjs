#!/usr/bin/env node
/**
 * dequalify-tenant-baselines — make the seven tenant-aware Baselines
 * replay-safe (DATA-CRITICAL-010).
 *
 * # The defect
 *
 * Provisioning a tenant is migration REPLAY: `tenant-schema-provisioner.ts`
 * calls `runSchemaMigrations({ schema: 'tenant_<uuid>' })` and
 * `migration-orchestrator.ts` pins `SET search_path TO "<schema>", public`
 * before every migration. That pin only redirects UNQUALIFIED DDL. Every
 * Baseline is fully source-schema-qualified (`CREATE TABLE "farm"."x"`)
 * because TypeORM's `migration:generate` emits it that way, so a tenant
 * replay creates nothing in the tenant schema and then aborts on the first
 * duplicate relation. No new tenant can be provisioned.
 *
 * This is a regression, not a design choice: the pre-reset corpus was
 * unqualified (`.archive/…/1700000000000-CreateInitialSchema.ts` — 49
 * CREATE TABLE, zero qualified identifiers). The 2026-05-18 day-one reset
 * regenerated the Baselines with the CLI and the property was lost.
 *
 * # Why a script rather than a hand edit
 *
 * Same reason `wrap-create-type-idempotent.mjs` exists: the generator's
 * output needs a mechanical, re-runnable correction, and a reviewer must be
 * able to reproduce the diff rather than trust it. Re-running is a no-op.
 *
 * # Why it is CLASSIFICATION-DRIVEN, not a blind prefix strip
 *
 * Each Baseline creates per-tenant tables AND cross-tenant infrastructure
 * tables (audit ledgers, outbox) in the same `up()`. `@SourceOnlyMigration`
 * is a CLASS decorator — there is no per-statement escape — so the split has
 * to live in the SQL itself: per-tenant DDL loses its schema prefix, and
 * cross-tenant DDL keeps it. The classifier is `MODULE_SCHEMAS` (the same
 * SSoT `entity-schema-declaration` uses for the entity layer), read at run
 * time so this script can never drift from it.
 *
 * Deliberately KEPT qualified, with the reason:
 *
 *   - Cross-tenant tables (`MODULE_SCHEMAS[].infrastructureTables`) and
 *     everything that hangs off them — indexes, their audit-guard function,
 *     trigger and REVOKE.
 *   - Every `CREATE TYPE` and every enum column-type reference. Existing
 *     tenants SHARE the source-schema enum (`CREATE TABLE … LIKE INCLUDING
 *     ALL` shares a type, it does not clone it — see orphan-type-reclamation).
 *     De-qualifying would give new tenants their own enums and split the
 *     fleet in two; keeping them qualified makes the replay's DO/EXCEPTION
 *     wrapper a no-op and binds tenant columns to the shared type, which is
 *     exactly what existing tenants have.
 *   - Cross-schema references (`REFERENCES "auth"."users"` in sensor). `auth`
 *     is not tenant-aware; the FK legitimately crosses schemas.
 *   - `create_hypertable('sensor.…')` literals. `sensor_readings` is retired
 *     and in neither MODULE_SCHEMAS list; `sensor_metrics`' per-tenant copy
 *     is already created unqualified by 1815000000000.
 *   - `CREATE EXTENSION` — cluster-global, not schema-scoped.
 *
 * Every occurrence the script does not recognise is KEPT and reported, so an
 * unclassified identifier fails loudly in review instead of being silently
 * rewritten.
 *
 * # The second pass: trigger functions
 *
 * A trigger function is written `"sensor".edge_policies_current_swap()` — the
 * schema is quoted, the function name is not — so the identifier pass above
 * cannot see it. Its classification is not its own: a function exists to serve
 * the table its trigger fires on, so it is per-tenant exactly when that table
 * is. That binding is read out of the `CREATE TRIGGER … ON <table> … EXECUTE
 * FUNCTION "<schema>".<fn>()` statements rather than listed here, so the pass
 * cannot drift from the DDL it is rewriting.
 *
 * Leaving a per-tenant function qualified would be a cross-schema write during
 * a tenant provision — `CREATE OR REPLACE FUNCTION` replacing the source
 * schema's copy — which is the whole class of defect this script exists to
 * remove. De-qualified, each tenant gets its own function bound to its own
 * trigger, and the source pass is byte-identical to today.
 *
 * # The third pass: postCondition
 *
 * De-qualifying is the fix; `postCondition()` is what stops the class from
 * coming back. The runner (`migration-orchestrator.ts:275-306`,
 * `migration-runner.service.ts:675-736`) runs the probe inside the migration's
 * own transaction, before the ledger row is written — a probe that returns
 * false rolls the whole thing back and the migration stays pending. So a
 * Baseline whose DDL lands anywhere other than the schema being replayed
 * FAILS LOUDLY instead of writing "applied" over an empty tenant schema, which
 * is exactly how DATA-CRITICAL-010 stayed invisible.
 *
 * The probe asserts the FULL per-tenant table set, not a canary, and the list
 * is generated from the file's own `CREATE TABLE` statements. Generated rather
 * than hand-listed because a hand-listed set is a second SSoT that silently
 * goes stale; regenerated, it is a projection of the DDL above it and a re-run
 * proves it still matches.
 *
 * # Usage
 *
 *   node scripts/migration/dequalify-tenant-baselines.mjs            # report only
 *   node scripts/migration/dequalify-tenant-baselines.mjs --apply    # rewrite
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APPLY = process.argv.includes('--apply');

/** The seven tenant-aware services and their Baseline files. */
const TENANT_AWARE_BASELINES = [
  { schema: 'farm', path: 'apps/farm-service/src/database/migrations/1800000000000-Baseline.ts' },
  {
    schema: 'sensor',
    path: 'apps/sensor-service/src/database/migrations/1800000000000-Baseline.ts',
  },
  { schema: 'hr', path: 'apps/hr-service/src/database/migrations/1800000000000-Baseline.ts' },
  { schema: 'messaging', path: 'apps/messaging-service/src/migrations/1800000000000-Baseline.ts' },
  {
    schema: 'hydroponics',
    path: 'apps/hydroponics-service/src/database/migrations/1800000000000-Baseline.ts',
  },
  { schema: 'alert', path: 'apps/alert-engine/src/database/migrations/1800000000000-Baseline.ts' },
  { schema: 'ai', path: 'apps/ai-service/src/database/migrations/1800000000000-Baseline.ts' },
];

/**
 * Read the per-tenant / cross-tenant split from MODULE_SCHEMAS itself.
 * ts-node with the db-migrate tsconfig is how the workflow already loads
 * backend-common from a script context.
 */
function loadClassification() {
  const script = [
    "import { MODULE_SCHEMAS } from '@aquaculture/backend-common/database';",
    'const out: Record<string, { perTenant: string[]; infrastructure: string[] }> = {};',
    'for (const m of MODULE_SCHEMAS) {',
    '  out[m.sourceSchema] = {',
    '    perTenant: [...m.tables, ...(m.referenceDataTables ?? [])],',
    '    infrastructure: [...(m.infrastructureTables ?? [])],',
    '  };',
    '}',
    'process.stdout.write(JSON.stringify(out));',
  ].join('\n');

  const raw = execFileSync(
    'npx',
    [
      'ts-node',
      '--project',
      'apps/db-migrate/tsconfig.app.json',
      '-r',
      'tsconfig-paths/register',
      '-e',
      script,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(raw);
}

/**
 * `CREATE [UNIQUE] INDEX "name" ON "schema"."table"` — an index inherits its
 * table's classification, and `DROP INDEX "schema"."name"` carries no table,
 * so the map has to be built from the create side first.
 */
function indexOwners(source, schema) {
  const owners = new Map();
  // Both spellings: the replay-safety pass below rewrites these to
  // `CREATE INDEX IF NOT EXISTS`, and this map is rebuilt from the transformed
  // text on every subsequent run — a map that only knew the bare form would
  // lose every index's owner the moment the file became idempotent.
  const rx = new RegExp(
    `CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"([^"]+)"\\s+ON\\s+"${schema}"\\."([^"]+)"`,
    'g',
  );
  for (const match of source.matchAll(rx)) {
    if (match[1] && match[2]) owners.set(match[1], match[2]);
  }
  return owners;
}

/**
 * Enum type names, from their own `CREATE TYPE … AS ENUM` definitions rather
 * than from a naming convention — farm's `equipment_category` is an enum and
 * carries no `_enum` suffix, so a convention would have mis-sorted it.
 */
function enumTypes(source, schema) {
  const names = new Set();
  const rx = new RegExp(`CREATE TYPE "${schema}"\\."([^"]+)" AS ENUM`, 'g');
  for (const match of source.matchAll(rx)) {
    if (match[1]) names.add(match[1]);
  }
  return names;
}

/**
 * `CREATE TRIGGER … ON [ "schema". ] "table" … EXECUTE FUNCTION "schema".fn()`
 * — the only place the DDL states which table a trigger function serves. The
 * schema qualifier on the table is optional because the identifier pass has
 * already run by the time this map is built.
 */
function functionOwners(source, schema) {
  const owners = new Map();
  // The gaps exclude a backtick so a match can never run past the end of the
  // template literal holding this statement into the next one — without that
  // bound, a trigger whose EXECUTE FUNCTION this pass already de-qualified
  // would reach forward and claim the NEXT statement's function as its own.
  // `CREATE OR REPLACE TRIGGER` for the same reason indexOwners accepts
  // `IF NOT EXISTS`: the replay-safety pass produces it, and this map is
  // rebuilt from the transformed text on the next run.
  const rx = new RegExp(
    'CREATE\\s+(?:OR\\s+REPLACE\\s+)?TRIGGER\\s+[^`]*?\\sON\\s+(?:"[^"]+"\\.)?"([^"]+)"' +
      `[^\`]*?EXECUTE\\s+FUNCTION\\s+"${schema}"\\.([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`,
    'g',
  );
  for (const match of source.matchAll(rx)) {
    if (match[1] && match[2]) owners.set(match[2], match[1]);
  }
  return owners;
}

/**
 * A constraint named in `ALTER TABLE … ADD CONSTRAINT "x"` belongs to the
 * table it is added to; no separate map is needed because those statements
 * always name the table in the same statement.
 */
function classify(identifier, { perTenant, infrastructure, indexes, enums }) {
  if (enums.has(identifier)) return 'enum';
  if (perTenant.has(identifier)) return 'per-tenant';
  if (infrastructure.has(identifier)) return 'cross-tenant';
  const owner = indexes.get(identifier);
  if (owner !== undefined) {
    if (enums.has(owner)) return 'enum';
    if (perTenant.has(owner)) return 'per-tenant';
    if (infrastructure.has(owner)) return 'cross-tenant';
    return 'unregistered-table';
  }
  return 'unregistered-table';
}

const PROBE_BEGIN = '    // ── GENERATED postCondition (DATA-CRITICAL-010) — do not hand-edit ──';
const PROBE_END = '    // ── END GENERATED postCondition ──';

/**
 * Emit (or replace) the `postCondition()` probe. Only tables the transform
 * left UNQUALIFIED are asserted: a qualified one is cross-tenant and does not
 * belong in a tenant schema at all, so demanding it in `current_schema()`
 * would turn a correct replay into a failure.
 */
function withPostCondition(source) {
  const stripped = source.replace(
    new RegExp(`\\n${escapeForRegex(PROBE_BEGIN)}[\\s\\S]*?${escapeForRegex(PROBE_END)}\\n`, 'g'),
    '',
  );

  const tables = [
    ...new Set(
      // The ` (` is load-bearing: without it `"ai"."tool_execution_audit"`
      // would contribute the SCHEMA name as a table, and the probe would then
      // demand a table called `ai` in every tenant schema.
      [...stripped.matchAll(/CREATE TABLE IF NOT EXISTS "([^".]+)" \(/g)].map((match) => match[1]),
    ),
  ].sort();
  if (tables.length === 0) return { source: stripped, tables };

  const values = tables.map((table) => `('${table}')`).join(', ');
  const block = [
    PROBE_BEGIN,
    '    public async postCondition(queryRunner: QueryRunner): Promise<boolean> {',
    '        const rows: Array<{ missing: string }> = await queryRunner.query(`',
    '            SELECT expected.table_name AS missing',
    `              FROM (VALUES ${values}) AS expected(table_name)`,
    '             WHERE NOT EXISTS (',
    '               SELECT 1',
    '                 FROM information_schema.tables',
    '                WHERE table_schema = current_schema()',
    '                  AND table_name = expected.table_name',
    '             )',
    '        `);',
    '        return rows.length === 0;',
    '    }',
    PROBE_END,
  ].join('\n');

  const anchor = '\n    public async down(queryRunner: QueryRunner): Promise<void> {';
  const at = stripped.indexOf(anchor);
  if (at === -1) {
    throw new Error('no `public async down(queryRunner: QueryRunner)` anchor to insert before');
  }
  return { source: `${stripped.slice(0, at)}\n${block}\n${stripped.slice(at)}`, tables };
}

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteFile(entry, classification) {
  const absolute = resolve(REPO_ROOT, entry.path);
  if (!existsSync(absolute)) {
    return { ...entry, missing: true };
  }
  const original = readFileSync(absolute, 'utf8');
  const known = classification[entry.schema];
  if (known === undefined) {
    throw new Error(`MODULE_SCHEMAS has no entry for source schema "${entry.schema}"`);
  }

  const context = {
    perTenant: new Set(known.perTenant),
    infrastructure: new Set(known.infrastructure),
    indexes: indexOwners(original, entry.schema),
    enums: enumTypes(original, entry.schema),
  };

  const stats = {
    dequalified: 0,
    keptCrossTenant: 0,
    keptEnum: 0,
    keptUnregistered: new Map(),
    dequalifiedFunction: 0,
    keptCrossTenantFunction: 0,
    replaySafe: 0,
    keptUnboundFunction: new Map(),
  };

  // `"<schema>"."<identifier>"` — the only form this script rewrites. Bare
  // `schema.table` inside a string literal (the create_hypertable calls) is
  // deliberately not matched; see the header.
  const qualified = new RegExp(`"${entry.schema}"\\."([^"]+)"`, 'g');
  let next = original.replace(qualified, (whole, identifier) => {
    const verdict = classify(identifier, context);
    if (verdict === 'per-tenant') {
      stats.dequalified += 1;
      return `"${identifier}"`;
    }
    if (verdict === 'cross-tenant') {
      stats.keptCrossTenant += 1;
      return whole;
    }
    if (verdict === 'enum') {
      stats.keptEnum += 1;
      return whole;
    }
    stats.keptUnregistered.set(identifier, (stats.keptUnregistered.get(identifier) ?? 0) + 1);
    return whole;
  });

  // Second pass — trigger functions, whose classification is their table's.
  // `"<schema>".<unquoted>` cannot collide with the pass above, which only
  // matches when the identifier after the dot is quoted.
  const owners = functionOwners(next, entry.schema);
  const functionRef = new RegExp(`"${entry.schema}"\\.(?!")([A-Za-z_][A-Za-z0-9_]*)`, 'g');
  next = next.replace(functionRef, (whole, fn) => {
    const table = owners.get(fn);
    if (table === undefined) {
      stats.keptUnboundFunction.set(fn, (stats.keptUnboundFunction.get(fn) ?? 0) + 1);
      return whole;
    }
    if (classify(table, context) === 'per-tenant') {
      stats.dequalifiedFunction += 1;
      return fn;
    }
    stats.keptCrossTenantFunction += 1;
    return whole;
  });

  // Everything the Baseline still addresses BY SOURCE-SCHEMA NAME has to
  // tolerate already existing. A tenant replay executes the whole up(),
  // cross-tenant statements included — they are correctly qualified, so they
  // hit the SAME object the source pass already created, and a bare CREATE
  // aborts the provision. The live provisioning gate caught this as
  // `relation "IDX_farm_audit_tenant" already exists` after the table half was
  // already idempotent: the tables were fixed, their indexes were not.
  //
  // CREATE OR REPLACE TRIGGER is PG14+; the platform runs PG16.
  let replaySafe = 0;
  const qualifiedIndex = new RegExp(
    `CREATE (UNIQUE )?INDEX "([^"]+)" ON "${entry.schema}"\\.`,
    'g',
  );
  next = next.replace(qualifiedIndex, (_whole, unique, name) => {
    replaySafe += 1;
    return `CREATE ${unique ?? ''}INDEX IF NOT EXISTS "${name}" ON "${entry.schema}".`;
  });
  const qualifiedTrigger = new RegExp(
    `CREATE TRIGGER ([^\\s]+)([^\`]*?ON "${entry.schema}"\\.)`,
    'g',
  );
  // `CREATE OR REPLACE TRIGGER` no longer matches the pattern above, so a
  // second run rewrites nothing — the pass is idempotent by construction.
  next = next.replace(qualifiedTrigger, (_whole, name, rest) => {
    replaySafe += 1;
    return `CREATE OR REPLACE TRIGGER ${name}${rest}`;
  });
  stats.replaySafe = replaySafe;

  // A de-qualified CREATE TABLE must also become idempotent: migration-sql-lint
  // R6 stops grandfathering a migration the moment it is modified, and a replay
  // that resumes after a partial failure needs the IF NOT EXISTS anyway.
  let idempotent = 0;
  // `CREATE TABLE "` cannot match the already-idempotent form, which reads
  // `CREATE TABLE IF NOT EXISTS "` — so this is a no-op on a second run.
  next = next.replace(/CREATE TABLE "/g, () => {
    idempotent += 1;
    return 'CREATE TABLE IF NOT EXISTS "';
  });
  stats.idempotent = idempotent;

  // Third pass — the probe, generated from the CREATE TABLE statements the two
  // passes above have finished rewriting.
  const probe = withPostCondition(next);
  next = probe.source;
  stats.asserted = probe.tables.length;

  const changed = next !== original;
  if (changed && APPLY) writeFileSync(absolute, next, 'utf8');
  return { ...entry, changed, stats };
}

function main() {
  const classification = loadClassification();
  let exitCode = 0;

  for (const entry of TENANT_AWARE_BASELINES) {
    const result = rewriteFile(entry, classification);
    if (result.missing) {
      process.stdout.write(`[skip] ${entry.path}: not found\n`);
      exitCode = 1;
      continue;
    }
    const {
      dequalified,
      keptCrossTenant,
      keptEnum,
      keptUnregistered,
      idempotent,
      dequalifiedFunction,
      keptCrossTenantFunction,
      keptUnboundFunction,
      asserted,
      replaySafe,
    } = result.stats;
    const verb = result.changed ? (APPLY ? '[ok]  ' : '[would]') : '[noop]';
    process.stdout.write(
      `${verb} ${entry.schema.padEnd(12)} dequalified=${String(dequalified).padStart(4)} ` +
        `kept_cross_tenant=${String(keptCrossTenant).padStart(3)} ` +
        `kept_enum=${String(keptEnum).padStart(4)} ` +
        `create_table_if_not_exists=${String(idempotent).padStart(3)} ` +
        `fn_dequalified=${dequalifiedFunction} fn_kept=${keptCrossTenantFunction} ` +
        `post_condition_asserts=${String(asserted).padStart(3)} ` +
        `replay_safe=${String(replaySafe).padStart(2)}\n`,
    );
    // A trigger function no CREATE TRIGGER binds to a table. Nothing in the
    // corpus produces one today; if one appears, its classification is a
    // judgement call a reviewer has to make, not something to guess at.
    if (keptUnboundFunction.size > 0) {
      process.stdout.write(
        `        kept_unbound_function: ${[...keptUnboundFunction.keys()].join(', ')}\n`,
      );
      exitCode = 1;
    }
    // Anything the registry does not classify is kept and named. Today this is
    // only tables a later migration retired (sensor_readings, tenant_ai_settings)
    // and their indexes; a NEW name appearing here means an entity shipped
    // without its MODULE_SCHEMAS entry and must be resolved, not waved through.
    if (keptUnregistered.size > 0) {
      const rendered = [...keptUnregistered.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([identifier, count]) => `${identifier}×${count}`)
        .join(', ');
      process.stdout.write(`        kept_unregistered: ${rendered}\n`);
    }
  }

  process.stdout.write(
    APPLY
      ? '\nApplied. Re-run without --apply; every line must read [noop].\n'
      : '\nDry run. Pass --apply to rewrite.\n',
  );
  process.exit(exitCode);
}

main();
