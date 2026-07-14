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
  '1803000000000-HashProvisioningSecretsAtRest.ts',
  '1800500000000-EnsureMessagingPartitionContract.ts',
  // ORPHAN-HIGH-408: immutable historical BUG — `ai_proposed_actions` is a
  // per-tenant table wrongly schema-qualified. Retained only because migrations
  // are immutable; HEALED by 1803100000000-HealAiProposedActionsUnqualified.
  // DO NOT copy this pattern: per-tenant tables must be UNQUALIFIED.
  '1803000000000-CreateAiProposedActions.ts',
]);

function migrationFiles(): string[] {
  const args = ['ls-files', ...TENANT_AWARE_MIGRATION_DIRS.map((dir) => `${dir}/[0-9]*.ts`)];
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !file.endsWith('1800000000000-Baseline.ts'));
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
