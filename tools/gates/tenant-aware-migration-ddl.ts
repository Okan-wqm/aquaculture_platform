/**
 * The tenant-aware qualified-DDL authority: whether a tenant-aware migration
 * issues DDL against a per-tenant table in its own SOURCE schema, by either
 * spelling — a schema-qualified identifier, or re-pinning the session's
 * search_path to the source schema.
 *
 * WHY (see the invariant spec `tests/invariants/tenant-aware-migration-ddl-guard.spec.ts`,
 * rewritten from DATA-HIGH-012): tenant provisioning is migration REPLAY — the
 * orchestrator pins `search_path` to `tenant_<uuid>` and runs each
 * tenant-aware service's migration set. That mechanism only redirects
 * UNQUALIFIED DDL. Anything that names its schema explicitly, or re-pins the
 * session to the source schema, escapes the replay, lands in the source
 * schema, and is STILL recorded in the tenant's ledger as applied
 * (MSG-HIGH-077; DATA-CRITICAL-010 lived entirely inside an earlier blanket
 * Baseline exclusion).
 *
 * ONE OWNER, TWO READERS (ARIA-MEDIUM-588): the invariant spec fails the
 * build on a violation with the registry imported from the RUNTIME
 * `MODULE_SCHEMAS`, and ARIA's `sql-migration-safety-adapter` observes the
 * same verdicts with the registry read from the workspace's own SSoT source
 * text (`tools/aria-adapters/module-schemas-source.ts` — the reader that
 * resolves spread entries such as
 * `...TENANT_ERASURE_PROOF_INFRASTRUCTURE_TABLES`, which is why this guard
 * could not previously be projected into the adapter at all). Both build the
 * same `TenantAwareDdlRegistry` and call the same classifier below, so the
 * gate and the observation cannot drift.
 *
 * The tenant-aware migration directories are DERIVED from the platform
 * catalog's `migrationGlobs` (via `tenantAwareMigrationGlobsBySchema()`),
 * never a hand-copied service list + path (ORPHAN-HIGH-406: the gate's first
 * spelling hard-coded `src/database/migrations` and was 100% blind to
 * messaging-service, whose live migrations sit in `src/migrations`).
 */
import { basename, dirname, posix } from 'node:path';

import { tenantAwareMigrationGlobsBySchema } from '../../platform/libs/service-catalog/src';

import { isTenantAwareMigrationPath } from './migration-shared-enum-drop';

/** The tables one source schema's DDL is classified against. */
export interface TenantAwareDdlRegistry {
  readonly perTenant: ReadonlySet<string>;
  readonly infrastructure: ReadonlySet<string>;
  readonly retired: ReadonlySet<string>;
}

/**
 * The registry for one module entry of MODULE_SCHEMAS (the runtime entry, or
 * the adapter-side reading — both carry the same fields). `retired` comes
 * from RETIRED_SOURCE_TABLES below.
 */
export function moduleSchemaRegistry(
  entry: {
    readonly tables: readonly string[];
    readonly referenceDataTables?: readonly string[];
    readonly infrastructureTables?: readonly string[];
  },
  retired: ReadonlySet<string>,
): TenantAwareDdlRegistry {
  return {
    perTenant: new Set([...entry.tables, ...(entry.referenceDataTables ?? [])]),
    infrastructure: new Set(entry.infrastructureTables ?? []),
    retired,
  };
}

/** Directory prefix → source schema, derived from the platform catalog. */
export function tenantAwareMigrationDirSchemas(): ReadonlyMap<string, string> {
  const dirs = new Map<string, string>();
  for (const entry of tenantAwareMigrationGlobsBySchema()) {
    dirs.set(dirname(entry.glob), entry.schema);
  }
  return dirs;
}

/** The source schema a tenant-aware migration directory belongs to, if any. */
export function tenantAwareSourceSchemaOf(relPath: string): string | null {
  if (!isTenantAwareMigrationPath(relPath)) return null;
  return tenantAwareMigrationDirSchemas().get(posix.dirname(relPath)) ?? null;
}

/**
 * Tables that exist in a shipped migration's DDL but in NEITHER
 * `MODULE_SCHEMAS[].tables` nor `[].infrastructureTables`, because a later
 * migration retired them. They cannot be classified and they cannot be edited
 * out of an immutable migration, so they are named here with the migration
 * that retired them. A NEW name appearing in a failure means an entity
 * shipped without its registry entry — register it, do not add it here.
 */
export const RETIRED_SOURCE_TABLES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // Superseded by the `sensor_metrics` hypertable; the per-tenant copy of that
  // is created unqualified by 1815000000000.
  ['sensor', new Set(['sensor_readings'])],
  // Dropped by 1802100000000-DropTenantAiSettings.
  ['messaging', new Set(['tenant_ai_settings'])],
]);

/**
 * Migrations whose source-schema-qualified DDL has been REVIEWED as
 * legitimate. This is a reviewer-gated allowlist in ONE place — the owner
 * module — not a self-service docblock marker: ORPHAN-HIGH-408's
 * `CreateAiProposedActions` used the old `TENANT_AWARE_SOURCE_SCHEMA_DDL_OK`
 * docblock marker to schema-qualify a PER-TENANT table, which the replay then
 * never landed in any tenant. A self-service marker bypasses CI silently; an
 * allowlist edit shows up in the PR diff. Adding an entry must be justified
 * in writing.
 */
export const REVIEWED_SOURCE_SCHEMA_DDL: ReadonlySet<string> = new Set([
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
  // (canonical `sensor` source copy + tenant fan-out).
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

/** A DDL verb + object immediately preceding a qualified identifier. */
const DDL_LEAD =
  /\b(?:CREATE|ALTER|DROP|TRUNCATE)\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TYPE|SEQUENCE|VIEW|MATERIALIZED\s+VIEW)\b(?:\s+IF\s+(?:NOT\s+)?EXISTS)?[\s\S]{0,220}$/i;

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
  registry: TenantAwareDdlRegistry,
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

export interface Offence {
  readonly file: string;
  readonly reason: string;
  /** 1-based line of the offending identifier in the RAW source. */
  readonly line: number;
}

/**
 * Comment-blanking for source-text classification, moved here from
 * tests/invariants/helpers/ts-source.ts (which re-exports it) because it is
 * part of THIS rule: a migration docblock that DESCRIBES the violation —
 * MSG-HIGH-077's fix wrote `pinSearchPath(queryRunner, 'messaging')` into two
 * docblocks to explain why it must not be called — must not classify as one.
 * Regex-based stripping cannot work (`//` and `/*` occur inside SQL
 * template literals), so this walks the source tracking string, template and
 * comment state, and blanks comment bodies while preserving offsets so a
 * reported index still points at the right place in the original file.
 *
 * `qualifiedDdlOffences` and `sourcePinOffences` apply it internally, so every
 * reader of the rule (the invariant spec, the adapter) classifies identical
 * text — a reader forgetting to strip cannot drift from the gate.
 */
export function stripComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let state: State = 'code';

  const blank = (ch: string): string => (ch === '\n' ? '\n' : ' ');

  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];

    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line';
        out.push('  ');
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block';
        out.push('  ');
        i += 2;
        continue;
      }
      if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '`') state = 'template';
      out.push(ch);
      i += 1;
      continue;
    }

    if (state === 'line') {
      if (ch === '\n') state = 'code';
      out.push(blank(ch));
      i += 1;
      continue;
    }

    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        out.push('  ');
        i += 2;
        continue;
      }
      out.push(blank(ch));
      i += 1;
      continue;
    }

    // Inside a string or template literal: copy verbatim, honour escapes.
    if (ch === '\\') {
      out.push(ch, source[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (
      (state === 'single' && ch === "'") ||
      (state === 'double' && ch === '"') ||
      (state === 'template' && ch === '`')
    ) {
      state = 'code';
    }
    out.push(ch);
    i += 1;
  }

  return out.join('');
}

/**
 * Qualified DDL naming something that must not live in the source schema.
 * Fail-closed: a qualified identifier the registry cannot explain is a
 * VIOLATION, not a pass — an unregistered per-tenant table is exactly the
 * shape that would otherwise slip through.
 */
export function qualifiedDdlOffences(
  file: string,
  source: string,
  schema: string,
  registry: TenantAwareDdlRegistry,
): Offence[] {
  const raw = source;
  source = stripComments(source);
  const indexes = indexOwners(source, schema);
  const enums = enumTypes(source, schema);
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
      // stripComments preserves offsets, so the index in the blanked source is
      // the index in the raw source.
      line: raw.slice(0, match.index).split('\n').length,
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
 * migration. Legitimate on a source-only migration, where the tenant pass
 * skips the file entirely; a silent tenant-data hole anywhere else.
 */
export function sourcePinOffences(file: string, source: string, schema: string): Offence[] {
  const raw = source;
  source = stripComments(source);
  if (/@SourceOnlyMigration\s*\(/.test(source)) return [];
  const rx = new RegExp(
    `\\bpinSearchPath\\s*\\(\\s*[A-Za-z_$][\\w$]*\\s*,\\s*['"\`]${schema}['"\`]`,
    'g',
  );
  const match = rx.exec(source);
  if (match === null) return [];
  return [
    {
      file,
      line: raw.slice(0, match.index).split('\n').length,
      reason:
        `pinSearchPath(queryRunner, '${schema}') in a migration that is not @SourceOnlyMigration. ` +
        `It pins its literal argument, so a tenant pass re-pins the SOURCE schema, the DDL no-ops ` +
        `against rows that already exist there, and the tenant ledger records a successful apply ` +
        `anyway (MSG-HIGH-077). Either drop the pin and follow the runner's, or mark the migration ` +
        `@SourceOnlyMigration if the table really is cross-tenant.`,
    },
  ];
}

/** The reviewed-allowlist check both readers apply, by file base name. */
export function isReviewedSourceSchemaDdl(fileName: string): boolean {
  return REVIEWED_SOURCE_SCHEMA_DDL.has(basename(fileName));
}
