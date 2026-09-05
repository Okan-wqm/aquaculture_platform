import { readFileSync } from 'fs';
import { basename, join, relative } from 'path';
import { execFileSync } from 'child_process';

const REPO_ROOT = join(__dirname, '..', '..');

const TENANT_AWARE_MIGRATION_DIRS = [
  'apps/farm-service/src/database/migrations',
  'apps/sensor-service/src/database/migrations',
  'apps/hr-service/src/database/migrations',
  'apps/messaging-service/src/migrations',
  'apps/messaging-service/src/database/migrations',
  'apps/alert-engine/src/database/migrations',
  'apps/ai-service/src/database/migrations',
  'apps/hydroponics-service/src/database/migrations',
] as const;

const SOURCE_SCHEMA_QUALIFIED_DDL =
  /\b(?:CREATE|ALTER|DROP|TRUNCATE)\s+(?:TABLE|INDEX|TYPE|SEQUENCE|VIEW|MATERIALIZED\s+VIEW)\b[\s\S]{0,220}"(?:farm|sensor|hr|messaging|alert|ai|hydroponics)"\."/i;

/**
 * Migrations whose source-schema-qualified DDL has been REVIEWED as legitimate
 * (cross-tenant infra tables that live in the source schema, source-only enum
 * drops/heals, or partition-contract indexes — NOT per-tenant tables). This is
 * a reviewer-gated allowlist in THIS spec, not a self-service docblock marker:
 * ORPHAN-HIGH-408's `CreateAiProposedActions` added the old
 * `TENANT_AWARE_SOURCE_SCHEMA_DDL_OK` docblock marker to schema-qualify a
 * PER-TENANT table (`ai_proposed_actions`), which the replay then never landed
 * in any tenant schema. A self-service marker let that bypass CI silently; an
 * allowlist edit shows up in the PR diff for a reviewer to catch. Adding a new
 * entry here must be justified as genuinely source-schema (cross-tenant) DDL.
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

/**
 * The per-service Baseline. Every one of them is fully source-schema-qualified
 * (TypeORM's CLI generates it that way), so each is a live violation of the
 * rule this spec enforces — and NOT a harmless one: DATA-CRITICAL-010 proves by
 * running the production orchestrator against a live database that replaying a
 * Baseline into a tenant schema creates zero tables there and then aborts with
 * `relation "…" already exists`, which is why no NEW tenant can be provisioned.
 *
 * The exclusion is kept because fixing it means rewriting eight Baselines (or
 * changing the provisioner's journal-seeding contract) under
 * architectural-arbiter review, with a live provisioning run as the gate — work
 * tracked as DATA-CRITICAL-010 (owner data-expert, deadline 2026-08-15). It is
 * named and explained here rather than applied as an unremarked `.filter()` so
 * the hole is visible to the next reader instead of looking like an oversight.
 */
const BASELINE_FILENAME = '1800000000000-Baseline.ts';

function migrationFiles(): string[] {
  const args = ['ls-files', ...TENANT_AWARE_MIGRATION_DIRS.map((dir) => `${dir}/[0-9]*.ts`)];
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !file.endsWith(BASELINE_FILENAME));
}

describe('tenant-aware migration DDL guard', () => {
  it('tenant-aware migrations avoid source-schema-qualified DDL unless reviewer-allowlisted', () => {
    const offenders: string[] = [];
    for (const file of migrationFiles()) {
      const src = readFileSync(join(REPO_ROOT, file), 'utf8');
      if (!SOURCE_SCHEMA_QUALIFIED_DDL.test(src)) continue;
      if (REVIEWED_SOURCE_SCHEMA_DDL.has(basename(file))) continue;
      offenders.push(relative(REPO_ROOT, join(REPO_ROOT, file)));
    }

    expect(offenders).toEqual([]);
  });

  it('every allowlisted migration still exists (no stale exemptions)', () => {
    const present = new Set(migrationFiles().map((f) => basename(f)));
    const stale = [...REVIEWED_SOURCE_SCHEMA_DDL].filter((name) => !present.has(name));
    expect(stale).toEqual([]);
  });
});
