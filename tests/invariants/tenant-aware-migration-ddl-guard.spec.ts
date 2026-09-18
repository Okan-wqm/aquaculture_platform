import { readFileSync } from 'fs';
import { basename, join, relative } from 'path';
import { execFileSync } from 'child_process';

import { MODULE_SCHEMAS } from '../../libs/backend-common/src/database/schema-manager.service';
import { stripComments } from './helpers/ts-source';

/**
 * Tenant provisioning is migration REPLAY: the orchestrator pins
 * `search_path` to `tenant_<uuid>` and runs each tenant-aware service's
 * migration set. That mechanism only redirects UNQUALIFIED DDL. Anything that
 * names its schema explicitly — or re-pins the session to the source schema —
 * escapes it, lands in the source schema, and is STILL recorded in the tenant's
 * ledger as applied. This spec is the gate for that class.
 *
 * ## Why this spec was rewritten (DATA-HIGH-012)
 *
 * The previous detector was a single regex looking for a DDL keyword followed
 * by a `"<source schema>".` identifier, plus a filename allowlist and a blanket
 * exclusion for every Baseline. It enumerated one SPELLING of the defect rather
 * than testing the property, and both halves of that leaked:
 *
 *   - MSG-HIGH-077 shipped a per-tenant migration that re-pinned its own source
 *     schema — functionally identical to qualifying every statement in the file
 *     — CITING THIS GUARD in its docblock as evidence of its own correctness.
 *   - DATA-CRITICAL-010 (no new tenant can be provisioned) lived entirely
 *     inside the Baseline exclusion.
 *
 * It now asks the actual question — *does this migration issue DDL against a
 * PER-TENANT table in the source schema, by either spelling?* — using
 * `MODULE_SCHEMAS` as the classifier. That is the same SSoT the entity layer
 * obeys via `entity-schema-declaration`, so the guard cannot drift from it, and
 * the Baselines are now checked like every other migration rather than excused.
 *
 * `scripts/migration/dequalify-tenant-baselines.mjs` reads the same registry to
 * decide what to rewrite. Two consumers of one SSoT, not two SSoTs.
 *
 * ## Fail-closed
 *
 * A qualified identifier the registry cannot explain is a VIOLATION, not a
 * pass. An unregistered per-tenant table is exactly the shape that would
 * otherwise slip through, so "I don't recognise this" resolves against the
 * migration and lands in the reviewer allowlist below with a written reason.
 */

const REPO_ROOT = join(__dirname, '..', '..');

/** Source schema per tenant-aware migration directory. */
const TENANT_AWARE_MIGRATION_DIRS: ReadonlyArray<readonly [string, string]> = [
  ['apps/farm-service/src/database/migrations', 'farm'],
  ['apps/sensor-service/src/database/migrations', 'sensor'],
  ['apps/hr-service/src/database/migrations', 'hr'],
  ['apps/messaging-service/src/migrations', 'messaging'],
  ['apps/messaging-service/src/database/migrations', 'messaging'],
  ['apps/alert-engine/src/database/migrations', 'alert'],
  ['apps/ai-service/src/database/migrations', 'ai'],
  ['apps/hydroponics-service/src/database/migrations', 'hydroponics'],
];

/** A DDL verb + object immediately preceding a qualified identifier. */
const DDL_LEAD =
  /\b(?:CREATE|ALTER|DROP|TRUNCATE)\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TYPE|SEQUENCE|VIEW|MATERIALIZED\s+VIEW)\b(?:\s+IF\s+(?:NOT\s+)?EXISTS)?[\s\S]{0,220}$/i;

/**
 * Tables that exist in a shipped migration's DDL but in NEITHER
 * `MODULE_SCHEMAS[].tables` nor `[].infrastructureTables`, because a later
 * migration retired them. They cannot be classified and they cannot be edited
 * out of an immutable migration, so they are named here with the migration that
 * retired them. A NEW name appearing in a failure means an entity shipped
 * without its registry entry — register it, do not add it here.
 */
const RETIRED_SOURCE_TABLES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // Superseded by the `sensor_metrics` hypertable; the per-tenant copy of that
  // is created unqualified by 1815000000000.
  ['sensor', new Set(['sensor_readings'])],
  // Dropped by 1802100000000-DropTenantAiSettings.
  ['messaging', new Set(['tenant_ai_settings'])],
]);

/**
 * Migrations whose source-schema-qualified DDL has been REVIEWED as legitimate.
 * This is a reviewer-gated allowlist in THIS spec, not a self-service docblock
 * marker: ORPHAN-HIGH-408's `CreateAiProposedActions` used the old
 * `TENANT_AWARE_SOURCE_SCHEMA_DDL_OK` docblock marker to schema-qualify a
 * PER-TENANT table, which the replay then never landed in any tenant. A
 * self-service marker bypasses CI silently; an allowlist edit shows up in the
 * PR diff. Adding an entry must be justified in writing.
 */
const REVIEWED_SOURCE_SCHEMA_DDL: ReadonlySet<string> = new Set([
  // Source-only enum reclaim/heal of the 2026-07-07 QualityGrade outage.
  '1804400000000-DropOrphanQualityGradeEnum.ts',
  '1804500000000-HealBehindTenantQualityGrade.ts',
  // Cross-tenant source-schema tables + partition-contract index (not cloned).
  '1800300000000-SensorV2TenantFkAndLicenseGrant.ts',
  '1802000000000-AddVfdDeviceModelSeriesPumpTags.ts',
  '1804000000000-ConsolidateVfdRegisterMappingsToSensorSchema.ts',
  // SENSOR-CRITICAL-007 Slice 1: nullable edge-binding columns on the per-tenant
  // vfd_devices table via the SAME source-template + tenant fan-out pattern as
  // 1802000000000 above (canonical `sensor` copy + every `tenant_*` copy). Not a
  // per-tenant table wrongly schema-qualified — the fan-out lands it everywhere.
  '1808000000000-AddVfdDeviceEdgeBinding.ts',
  // SEC-MEDIUM-083: partial unique index on the per-tenant vfd_change_sets
  // table — canonical `sensor` copy + tenant fan-out (same pattern as
  // 1808000000000 above). Per-tenant, not misqualified.
  '1818000000000-EnforceSingleActiveVfdChangeSet.ts',
  // SENSOR-HIGH-064: nullable config-ack tracking columns on the per-tenant
  // edge_devices table via the SAME source-template + tenant fan-out pattern
  // (canonical `sensor` copy + every `tenant_*` copy).
  '1809000000000-AddEdgeDeviceConfigAckTracking.ts',
  // SENSOR-HIGH-083: per-tenant calibration_events table + nullable
  // calibration_interval_days column on sensor_data_channels, both created in the
  // canonical `sensor` source schema and fanned out into every `tenant_*` schema
  // (CREATE TABLE … LIKE INCLUDING ALL for the clone). Per-tenant, not misqualified.
  '1810000000000-AddCalibrationEventsAndInterval.ts',
  '1803000000000-HashProvisioningSecretsAtRest.ts',
  '1800500000000-EnsureMessagingPartitionContract.ts',
  // ORPHAN-HIGH-408: immutable historical BUG — `ai_proposed_actions` is a
  // per-tenant table wrongly schema-qualified. Retained only because migrations
  // are immutable; HEALED by 1803100000000-HealAiProposedActionsUnqualified.
  // DO NOT copy this pattern: per-tenant tables must be UNQUALIFIED.
  '1803000000000-CreateAiProposedActions.ts',
]);

interface Registry {
  readonly perTenant: ReadonlySet<string>;
  readonly infrastructure: ReadonlySet<string>;
  readonly retired: ReadonlySet<string>;
}

function registryFor(schema: string): Registry {
  const entry = MODULE_SCHEMAS.find((m) => m.sourceSchema === schema);
  if (entry === undefined) {
    throw new Error(`MODULE_SCHEMAS has no entry for source schema "${schema}"`);
  }
  return {
    perTenant: new Set([...entry.tables, ...(entry.referenceDataTables ?? [])]),
    infrastructure: new Set(entry.infrastructureTables ?? []),
    retired: RETIRED_SOURCE_TABLES.get(schema) ?? new Set<string>(),
  };
}

/**
 * `CREATE [UNIQUE] INDEX "name" ON "schema"."table"` — an index inherits its
 * table's classification, and `DROP INDEX "schema"."name"` names no table, so
 * the map has to be built from the create side first.
 */
function indexOwners(source: string, schema: string): Map<string, string> {
  const owners = new Map<string, string>();
  const rx = new RegExp(
    `CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"([^"]+)"\\s+ON\\s+(?:"${schema}"\\.)?"([^"]+)"`,
    'gi',
  );
  for (const match of source.matchAll(rx)) {
    if (match[1] !== undefined && match[2] !== undefined) owners.set(match[1], match[2]);
  }
  return owners;
}

/**
 * Enum type names from their own definitions rather than from a naming
 * convention — farm's `equipment_category` is an enum and carries no `_enum`
 * suffix. Enums are DELIBERATELY left qualified: existing tenants SHARE the
 * source-schema type (`CREATE TABLE … LIKE INCLUDING ALL` shares a type, it does
 * not clone it), so de-qualifying would split the fleet in two.
 */
function enumTypes(source: string, schema: string): Set<string> {
  const names = new Set<string>();
  const rx = new RegExp(`CREATE\\s+TYPE\\s+"${schema}"\\."([^"]+)"\\s+AS\\s+ENUM`, 'gi');
  for (const match of source.matchAll(rx)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return names;
}

type Verdict = 'per-tenant' | 'cross-tenant' | 'enum' | 'retired' | 'unclassified';

function classify(
  identifier: string,
  registry: Registry,
  indexes: Map<string, string>,
  enums: Set<string>,
): Verdict {
  if (enums.has(identifier)) return 'enum';
  if (registry.perTenant.has(identifier)) return 'per-tenant';
  if (registry.infrastructure.has(identifier)) return 'cross-tenant';
  if (registry.retired.has(identifier)) return 'retired';
  const owner = indexes.get(identifier);
  if (owner !== undefined && owner !== identifier) {
    return classify(owner, registry, indexes, enums);
  }
  return 'unclassified';
}

interface Offence {
  readonly file: string;
  readonly reason: string;
}

/** Qualified DDL naming something that must not live in the source schema. */
function qualifiedDdlOffences(file: string, source: string, schema: string): Offence[] {
  const indexes = indexOwners(source, schema);
  const enums = enumTypes(source, schema);
  const registry = registryFor(schema);
  const offences: Offence[] = [];
  const seen = new Set<string>();

  const rx = new RegExp(`"${schema}"\\."([^"]+)"`, 'g');
  for (const match of source.matchAll(rx)) {
    const identifier = match[1];
    if (identifier === undefined) continue;
    // Only DDL counts. A qualified name inside a DML statement, a
    // `to_regclass()` probe or a RAISE message is not a routing decision.
    if (!DDL_LEAD.test(source.slice(0, match.index))) continue;

    const verdict = classify(identifier, registry, indexes, enums);
    if (verdict === 'cross-tenant' || verdict === 'enum' || verdict === 'retired') continue;
    if (seen.has(identifier)) continue;
    seen.add(identifier);

    offences.push({
      file,
      reason:
        verdict === 'per-tenant'
          ? `DDL on "${schema}"."${identifier}" — a PER-TENANT table (MODULE_SCHEMAS.${schema}.tables). ` +
            `The replay's search_path cannot redirect a qualified name, so every tenant pass writes to ` +
            `the source schema and the tenant ledger still records it as applied. Drop the "${schema}". prefix.`
          : `DDL on "${schema}"."${identifier}" — not in MODULE_SCHEMAS.${schema}.tables OR ` +
            `.infrastructureTables, so this guard cannot tell whether it belongs in a tenant schema. ` +
            `Register the table, or add the migration to REVIEWED_SOURCE_SCHEMA_DDL with a written reason.`,
    });
  }
  return offences;
}

/**
 * `pinSearchPath(qr, '<own source schema>')` in a migration that is NOT
 * `@SourceOnlyMigration` — the second spelling of the same defect. The helper
 * (`libs/backend-common/src/database/base-migration.ts`) issues
 * `SET search_path TO "<its literal argument>", public` and has no tenant
 * awareness, so it OVERRIDES the runner's tenant pin for the rest of the
 * migration. Legitimate on a source-only migration, where the tenant pass skips
 * the file entirely; a silent tenant-data hole anywhere else.
 */
function sourcePinOffences(file: string, source: string, schema: string): Offence[] {
  if (/@SourceOnlyMigration\s*\(/.test(source)) return [];
  const rx = new RegExp(
    `\\bpinSearchPath\\s*\\(\\s*[A-Za-z_$][\\w$]*\\s*,\\s*['"\`]${schema}['"\`]`,
    'g',
  );
  if (!rx.test(source)) return [];
  return [
    {
      file,
      reason:
        `pinSearchPath(queryRunner, '${schema}') in a migration that is not @SourceOnlyMigration. ` +
        `It pins its literal argument, so a tenant pass re-pins the SOURCE schema, the DDL no-ops ` +
        `against rows that already exist there, and the tenant ledger records a successful apply ` +
        `anyway (MSG-HIGH-077). Either drop the pin and follow the runner's, or mark the migration ` +
        `@SourceOnlyMigration if the table really is cross-tenant.`,
    },
  ];
}

function migrationFiles(): Array<readonly [string, string]> {
  const args = ['ls-files', ...TENANT_AWARE_MIGRATION_DIRS.map(([dir]) => `${dir}/[0-9]*.ts`)];
  const files = execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return files.map((file) => {
    const match = TENANT_AWARE_MIGRATION_DIRS.find(([dir]) => file.startsWith(`${dir}/`));
    if (match === undefined) throw new Error(`no source schema mapped for ${file}`);
    return [file, match[1]] as const;
  });
}

describe('tenant-aware migration DDL guard', () => {
  it('no tenant-aware migration issues source-schema DDL against a per-tenant table', () => {
    const offences: Offence[] = [];
    for (const [file, schema] of migrationFiles()) {
      if (REVIEWED_SOURCE_SCHEMA_DDL.has(basename(file))) continue;
      const source = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
      offences.push(...qualifiedDdlOffences(relative(REPO_ROOT, file), source, schema));
    }

    expect(offences.map((o) => `${o.file}: ${o.reason}`)).toEqual([]);
  });

  it('no tenant-aware migration re-pins its own source schema unless it is source-only', () => {
    const offences: Offence[] = [];
    for (const [file, schema] of migrationFiles()) {
      const source = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
      offences.push(...sourcePinOffences(relative(REPO_ROOT, file), source, schema));
    }

    expect(offences.map((o) => `${o.file}: ${o.reason}`)).toEqual([]);
  });

  it('every allowlisted migration still exists (no stale exemptions)', () => {
    const present = new Set(migrationFiles().map(([f]) => basename(f)));
    const stale = [...REVIEWED_SOURCE_SCHEMA_DDL].filter((name) => !present.has(name));
    expect(stale).toEqual([]);
  });

  it('every retired-table entry names a table the registry really does not carry', () => {
    const stale: string[] = [];
    for (const [schema, tables] of RETIRED_SOURCE_TABLES) {
      const registry = registryFor(schema);
      for (const table of tables) {
        if (registry.perTenant.has(table) || registry.infrastructure.has(table)) {
          stale.push(`${schema}.${table} is registered again — drop it from RETIRED_SOURCE_TABLES`);
        }
      }
    }
    expect(stale).toEqual([]);
  });
});
