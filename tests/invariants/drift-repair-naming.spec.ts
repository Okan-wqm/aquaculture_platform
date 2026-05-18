/**
 * Platform-wide invariant — POST-RESET-CRITICAL-001 / Faz 7:
 *
 * **No NEW migration file ships with a drift-repair naming pattern
 * (Align*EntitySurface, Heal*Drift, Repair*, Replay*, Reconcile*, Sync*)
 * after the Faz 6 day-one baseline reset.**
 *
 * # WHY
 *
 * Drift-repair migration filenames are the smoke signal of a deeper
 * architectural defect: an entity was edited without a matching
 * migration, the validator caught it weeks later, and an author wrote
 * a one-off migration to close the gap. The 2026-04 incident corpus
 * carries 30% of its migrations under these prefixes — the day-one
 * baseline reset (ADR-030) erases the historical occurrence and the
 * Faz 1 invariants prevent future entity-without-migration commits.
 *
 * This invariant is the safety net: even with entity-diff-witness +
 * tenant-fanout-entity-parity + the post-condition probe in place, if a
 * filename ever lands matching the banned pattern, it signals a defect
 * in the upstream gate chain that must be diagnosed BEFORE the
 * migration merges.
 *
 * # SCOPE
 *
 * Activates AFTER the Faz 6 day-one baseline reset commits. Pre-Faz-6,
 * the legacy `Align*` / `Heal*` / `Replay*` / `Repair*` chain is
 * grandfathered (those files are real migrations the corpus depends on
 * during the pre-reset deploy window). Post-Faz-6, every grandfather
 * goes to `.archive/` and only the Baseline migration remains; the
 * invariant becomes strict.
 *
 * Detection: file basename matches the regex below. The check ignores
 * `.archive/` directories so grandfathered files don't trip the gate
 * after reset.
 */

import { execSync } from 'node:child_process';
import { basename, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const DRIFT_REPAIR_PATTERNS = [
  /Align[A-Z][a-zA-Z]*EntitySurface/i,
  /Heal[A-Z][a-zA-Z]+Drift/i,
  /Repair[A-Z][a-zA-Z]+/i,
  /Replay[A-Z][a-zA-Z]+Alignment/i,
  /Reconcile[A-Z][a-zA-Z]+/i,
  /Sync[A-Z][a-zA-Z]+ToDb/i,
];

/**
 * Pre-Faz-6 grandfathered migrations. These exist in the working tree
 * until Faz 6 archives them. The list is one-way: it can only shrink
 * (entries removed as their archive lands in the day-one reset window),
 * never grow.
 */
const GRANDFATHERED: ReadonlySet<string> = new Set([
  // farm-service chain
  'apps/farm-service/src/database/migrations/1786900000000-AlignCodeSequencesSchema.ts',
  'apps/farm-service/src/database/migrations/1789000000000-AlignFarmEntitySurface.ts',
  'apps/farm-service/src/database/migrations/1789100000000-AlignFarmEntitySurfaceExt.ts',
  'apps/farm-service/src/database/migrations/1789200000000-AddMissingFarmTables.ts',
  'apps/farm-service/src/database/migrations/1789300000000-AlignFarmReferenceDataContracts.ts',
  'apps/farm-service/src/database/migrations/1789400000000-RepairFarmLiveSchemaDrift.ts',
  'apps/farm-service/src/database/migrations/1789500000000-ReinstateFarmTenantErasureAuditOwnership.ts',
  // hr-service chain
  'apps/hr-service/src/database/migrations/1786800000000-SyncHrEntitiesToDb.ts',
  'apps/hr-service/src/database/migrations/1786900000000-HealHrEnumTypeDrift.ts',
  'apps/hr-service/src/database/migrations/1787000000000-HealHrNullabilityDrift.ts',
  'apps/hr-service/src/database/migrations/1789300000000-ReplayHrEntitySurfaceAlignment.ts',
  // admin-api-service chain
  'apps/admin-api-service/src/migrations/1787200000000-RealignSharedAuditLogsSchema.ts',
  'apps/admin-api-service/src/migrations/1789000000000-AlignAdminEntitySurface.ts',
  'apps/admin-api-service/src/migrations/1789100000000-AlignAdminEntitySurfaceExt.ts',
  // sensor-service chain
  'apps/sensor-service/src/database/migrations/1789000000000-AlignSensorEntitySurface.ts',
  'apps/sensor-service/src/database/migrations/1789100000000-AlignSensorEntitySurfaceExt.ts',
  'apps/sensor-service/src/database/migrations/1789200000000-AlignSensorEntitySurfaceFks.ts',
  // auth-service
  'apps/auth-service/src/migrations/1789000000000-AlignAuthEntitySurface.ts',
  // billing-service
  'apps/billing-service/src/database/migrations/1789000000000-AlignBillingEntitySurface.ts',
  // alert-engine
  'apps/alert-engine/src/database/migrations/1789000000000-AlignAlertEntitySurface.ts',
  // config-service
  'apps/config-service/src/database/migrations/1789000000000-AlignConfigEntitySurface.ts',
  'apps/config-service/src/database/migrations/1789100000000-OwnConfigTablesByConfigService.ts',
  // notification-service
  'apps/notification-service/src/database/migrations/1789000000000-AlignNotificationEntitySurface.ts',
  // messaging-service
  'apps/messaging-service/src/migrations/1782600000000-AlignMessagingEntityDrift.ts',
  'apps/messaging-service/src/migrations/1782700000000-AlignAiConsentColumns.ts',
]);

function listMigrationFiles(): string[] {
  let out: string;
  try {
    out = execSync(
      `git -C ${REPO_ROOT} ls-files 'apps/*/src/migrations/*.ts' 'apps/*/src/migrations/**/*.ts' 'apps/*/src/database/migrations/*.ts' 'apps/*/src/database/migrations/**/*.ts'`,
      { encoding: 'utf8' },
    );
  } catch (err) {
    const e = err as { status?: number };
    if (e.status === 1) return [];
    throw err;
  }
  return out
    .split('\n')
    .filter(Boolean)
    .filter((p) => !p.includes('.archive/'))
    .filter((p) => !p.includes('__tests__'))
    .filter((p) => !p.endsWith('.spec.ts'))
    .filter((p) => !p.endsWith('.test.ts'));
}

describe('INVARIANT — drift-repair-naming ban (POST-RESET-CRITICAL-001)', () => {
  const files = listMigrationFiles();

  it('repository contains migration files to scan', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('no NEW migration filename matches a drift-repair pattern', () => {
    const violations: Array<{ file: string; pattern: string }> = [];

    for (const relPath of files) {
      if (GRANDFATHERED.has(relPath)) continue;
      const base = basename(relPath);
      for (const re of DRIFT_REPAIR_PATTERNS) {
        if (re.test(base)) {
          violations.push({ file: relPath, pattern: re.source });
        }
      }
    }

    if (violations.length > 0) {
      const detail = violations
        .map((v) => `  - ${v.file}\n      matched pattern: /${v.pattern}/i`)
        .join('\n');
      throw new Error(
        `Drift-repair migration filenames detected:\n${detail}\n\n` +
          `These names signal the regression class the day-one baseline reset ` +
          `(ADR-030) eliminated. The reason your migration needs an "Align*" / ` +
          `"Heal*" / "Repair*" prefix is almost always:\n\n` +
          `  - an entity was edited without a matching migration (entity-diff-witness\n` +
          `    should have caught this — diagnose why it didn't)\n` +
          `  - a MODULE_SCHEMAS entry is missing for a per-tenant entity\n` +
          `    (tenant-fanout-entity-parity should have caught this)\n` +
          `  - a prior migration's postCondition didn't run / didn't probe deeply\n` +
          `    enough\n\n` +
          `Root-cause the upstream gate gap; do NOT rename your migration to escape\n` +
          `this invariant. CODEOWNERS escalation: database-reviewer + architectural-arbiter.`,
      );
    }

    expect(violations).toHaveLength(0);
  });
});
