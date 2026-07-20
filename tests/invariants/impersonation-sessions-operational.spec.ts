/**
 * Platform-wide invariant — ADMIN-CRITICAL-013 / APA-288:
 *
 * `admin.impersonation_sessions` is an OPERATIONAL, lifecycle-mutated table —
 * NOT an append-only audit ledger. It MUST NOT carry a
 * `trg_impersonation_sessions_prevent_update` blanket-immutability trigger, and
 * the trigger-installing tooling MUST stay in lockstep with the ONE
 * classification SSoT (protected-tables.ts), so the misclassification cannot be
 * silently reintroduced (e.g. at the next baseline regeneration).
 *
 * # WHY (the regression class this pins)
 *
 * The day-one Baseline installed a BEFORE UPDATE OR DELETE trigger that RAISEd
 * on every write, treating impersonation_sessions as append-only. But the
 * service UPDATEs it on every session-lifecycle transition
 * (end/terminate/extend/expire/log-action), so the trigger deadlocked the whole
 * feature after creation. The category error was TRIPLE-hardcoded — the
 * compliance SSoT plus two generator scripts — so dropping the trigger alone
 * would be reinstated. This invariant is the make-detectable (tier-3) hedge that
 * keeps all three in agreement and RED-flags any re-introduction.
 *
 * # WHAT IS CHECKED (all source-level; no DB required)
 *
 *  1. SSoT shape: impersonation_sessions is in LIFECYCLE_GUARDED_TABLES and
 *     PROTECTED_TABLES (destructive-DDL protected) but NOT in APPEND_ONLY_TABLES.
 *  2. Net trigger: across admin-api migration up() bodies, the
 *     `trg_impersonation_sessions_prevent_update` trigger is created and then
 *     dropped — net absent. (Baseline's own down() DROP is excluded by
 *     up()-only slicing; the forward DROP must live in a later migration's up().)
 *  3. Script lockstep: baseline-generator.ts derives its expected-trigger set
 *     from the SSoT (no hardcoded list naming impersonation_sessions), and
 *     apply-audit-immutability.mjs no longer targets impersonation_sessions.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  APPEND_ONLY_TABLES,
  LIFECYCLE_GUARDED_TABLES,
  PROTECTED_TABLES,
  appendOnlyTableBaseNames,
} from '../../libs/backend-common/src/constants/protected-tables';

const REPO_ROOT = resolve(__dirname, '..', '..');
const TRIGGER = 'trg_impersonation_sessions_prevent_update';

function adminMigrationFiles(): string[] {
  const out = execSync(
    `git -C ${REPO_ROOT} ls-files apps/admin-api-service/src/migrations/*.ts`,
    { encoding: 'utf8' },
  );
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((p) => !p.includes('/.archive/'))
    .filter((p) => !p.includes('/__tests__/'))
    .filter((p) => !p.endsWith('.spec.ts'));
}

/**
 * Return only the up() body of a TypeORM migration. down() is the legitimate
 * inverse (Baseline's down() drops the trigger it created in up()); counting it
 * would falsely net the trigger to absent on HEAD. Slice from the up() method
 * signature to the down() signature (or file end when there is no down()).
 */
function upBody(src: string): string {
  const up = /(^|\n)\s*(public\s+|private\s+|protected\s+)?async\s+up\s*\(/.exec(src);
  if (!up) return '';
  const start = up.index;
  const down = /(^|\n)\s*(public\s+|private\s+|protected\s+)?async\s+down\s*\(/.exec(src);
  const end = down && down.index > start ? down.index : src.length;
  return src.slice(start, end);
}

describe('INVARIANT (ADMIN-CRITICAL-013 / APA-288): impersonation_sessions is operational, not append-only', () => {
  it('the classification SSoT marks impersonation_sessions operational, not append-only', () => {
    const table = 'admin.impersonation_sessions';
    expect(LIFECYCLE_GUARDED_TABLES as readonly string[]).toContain(table);
    // Still protected from destructive DDL (it holds a security record).
    expect(PROTECTED_TABLES as readonly string[]).toContain(table);
    // But NOT an append-only WORM ledger.
    expect(APPEND_ONLY_TABLES as readonly string[]).not.toContain(table);
    expect(appendOnlyTableBaseNames()).not.toContain('impersonation_sessions');
  });

  it('the prevent_update write-guard trigger is net-absent across admin migration up() bodies', () => {
    const files = adminMigrationFiles();
    expect(files.length).toBeGreaterThan(1);

    let created = 0;
    let dropped = 0;
    for (const rel of files) {
      const up = upBody(readFileSync(resolve(REPO_ROOT, rel), 'utf8'));
      if (new RegExp(`CREATE\\s+TRIGGER\\s+${TRIGGER}\\b`, 'i').test(up)) created += 1;
      if (new RegExp(`DROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?${TRIGGER}\\b`, 'i').test(up)) {
        dropped += 1;
      }
    }

    // Baseline creates it (sanity: the class we are guarding really existed).
    expect(created).toBeGreaterThanOrEqual(1);
    // A later forward migration drops it.
    expect(dropped).toBeGreaterThanOrEqual(1);
    // Net: no live prevent_update trigger remains on the operational table.
    expect(created - dropped).toBe(0);
  });

  it('baseline-generator.ts derives its append-only set from the SSoT (no impersonation hardcode)', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'scripts/migration/baseline-generator.ts'),
      'utf8',
    );
    // It must consume the SSoT helper…
    expect(src).toMatch(/appendOnlyTableBaseNames\s*\(/);
    // …and must NOT carry a hardcoded expected-trigger list naming the
    // operational table (the exact drift that froze it).
    expect(src).not.toMatch(/['"]impersonation_sessions['"]/);
  });

  it('apply-audit-immutability.mjs no longer targets impersonation_sessions', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'scripts/migration/apply-audit-immutability.mjs'),
      'utf8',
    );
    // The TARGETS entries must not list impersonation_sessions as a table to
    // install the append-only trigger on. (A comment naming it, explaining the
    // removal, is fine — so we assert it is not inside a `tables: [ ... ]`.)
    const tablesArrays = src.match(/tables:\s*\[[^\]]*\]/g) ?? [];
    for (const arr of tablesArrays) {
      expect(arr).not.toContain('impersonation_sessions');
    }
  });
});
