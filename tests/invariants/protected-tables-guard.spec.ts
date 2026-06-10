/**
 * Platform-wide invariant — COMPLIANCE-CRITICAL-001 / DBR-CRITICAL-001:
 *
 * **No migration may issue a destructive DDL operation on a protected
 * table or schema without an explicit `-- COMPLIANCE-WAIVER:` marker.**
 *
 * # WHY
 *
 * `libs/backend-common/src/constants/protected-tables.ts` lists tables
 * whose compliance invariants (audit immutability, legal-hold precedence,
 * append-only ledger semantics, outbox event preservation) cannot survive
 * a `DROP TABLE … CASCADE`, `DROP SCHEMA … CASCADE`, `TRUNCATE`, or
 * `ALTER TABLE … DROP COLUMN` without breaking SOC 2 / SOX / GDPR /
 * legal-discovery obligations.
 *
 * The 2026-04 `1782200000000-MoveSharedTablesFromAdminToShared` incident
 * (DROP TABLE shared.audit_logs CASCADE → silent immutability trigger
 * loss → 5 deploy windows with mutable audit log) is the canonical
 * regression class this gate prevents.
 *
 * The regular `-- DESTRUCTIVE:` marker enforced by R1 in
 * `tools/gates/migration-sql-lint.ts` is INSUFFICIENT for protected
 * tables — protected destruction requires the higher-bar
 * `-- COMPLIANCE-WAIVER:` marker (which gates CODEOWNERS approval from
 * compliance-expert + security-reviewer).
 *
 * # SCOPE
 *
 * Every TypeORM migration under:
 *   - `apps/*\/src/migrations/**\/*.ts`
 *   - `apps/*\/src/database/migrations/**\/*.ts`
 *
 * Excluded:
 *   - `__tests__/**` and `*.spec.ts` — these test helpers may build &
 *     tear down fixtures.
 *   - SQL files (`*.sql`) — currently used only by `apps/farm-service`'s
 *     legacy 001-007 raw-SQL chain; will be removed in Faz 3.
 *
 * # GRANDFATHERED HISTORICAL MIGRATIONS
 *
 * The following migrations performed protected-table destructive ops
 * BEFORE this guard was introduced. They remain merged for historical
 * fidelity (force-push ban + forward-only migration discipline). New
 * migrations cannot inherit grandfather status.
 *
 * After the day-one baseline reset (Faz 6), the grandfather list is
 * emptied — only `1800000000000-Baseline.ts` migrations exist, none of
 * which can carry a destructive op without the waiver marker.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  COMPLIANCE_WAIVER_MARKER_RE,
  PROTECTED_SCHEMAS,
  PROTECTED_TABLES,
  PROTECTED_TABLE_PATTERNS,
} from '../../libs/backend-common/src/constants/protected-tables';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Pre-day-one-reset historical migrations that ran destructive ops on
 * protected tables. After Faz 6, this list should be EMPTY — every
 * baseline migration is forward-only and additive.
 *
 * Each entry is the relative path from REPO_ROOT.
 */
const GRANDFATHERED_HISTORICAL_MIGRATIONS = new Set<string>([
  // 1782200: DROP TABLE shared.audit_logs CASCADE — root incident.
  'apps/admin-api-service/src/migrations/1782200000000-MoveSharedTablesFromAdminToShared.ts',
  // 1787200: DROP TABLE shared.audit_logs CASCADE — rebuild after schema realignment.
  'apps/admin-api-service/src/migrations/1787200000000-RealignSharedAuditLogsSchema.ts',
  // 1787400: Restore step that follows 1787200's CASCADE. Reads as destructive but
  // is the restoration path; explicitly grandfathered.
  'apps/admin-api-service/src/migrations/1787400000000-RestoreSharedAuditLogsImmutability.ts',
  // 1786900: AlignCodeSequencesSchema — tenant_* fan-out + rename. Reads as
  // destructive across tenant schemas but is the curated migration.
  'apps/farm-service/src/database/migrations/1786900000000-AlignCodeSequencesSchema.ts',
]);

/**
 * Patterns that signify a destructive DDL operation.
 * Each regex captures (when possible) the target table or schema name.
 *
 * Ordered most-blast-radius → least.
 */
const DESTRUCTIVE_PATTERNS: Array<{
  name: string;
  re: RegExp;
  targetType: 'schema' | 'table';
}> = [
  {
    name: 'DROP SCHEMA … CASCADE',
    re: /DROP\s+SCHEMA\s+(?:IF\s+EXISTS\s+)?["']?([a-z_][a-z0-9_]*)["']?\s+CASCADE/gi,
    targetType: 'schema',
  },
  {
    name: 'DROP TABLE … CASCADE',
    re: /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["']?([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)["']?\s+CASCADE/gi,
    targetType: 'table',
  },
  {
    name: 'DROP TABLE',
    re: /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["']?([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)["']?(?!\s*CASCADE)/gi,
    targetType: 'table',
  },
  {
    name: 'TRUNCATE',
    re: /TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?["']?([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)["']?/gi,
    targetType: 'table',
  },
];

interface Violation {
  file: string;
  pattern: string;
  target: string;
  excerpt: string;
}

/**
 * Find the start byte of `async down(` in a migration source. Returns
 * `src.length` (no body match) if the migration carries no down() method
 * — in that case the whole file body counts as up()/forward content.
 *
 * Why this matters: a TypeORM migration's down() is the legitimate
 * rollback path. `DROP TABLE foo` inside down() is the inverse of the
 * up() `CREATE TABLE foo` and is structurally correct. The compliance
 * concern is forward-direction destructive operations (up() body) on
 * compliance-critical tables, not their rollback counterparts.
 *
 * Match heuristic: regex catches `async down(`, `public async down(`,
 * `down(queryRunner` etc. — anything that starts a TypeORM down() method.
 */
function findDownMethodStart(src: string): number {
  const re = /(^|\n)\s*(public\s+|private\s+|protected\s+)?async\s+down\s*\(/;
  const m = re.exec(src);
  return m ? m.index : src.length;
}

function listMigrationFiles(): string[] {
  let grepOut: string;
  try {
    grepOut = execSync(
      `git -C ${REPO_ROOT} ls-files 'apps/*/src/migrations/*.ts' 'apps/*/src/migrations/**/*.ts' 'apps/*/src/database/migrations/*.ts' 'apps/*/src/database/migrations/**/*.ts'`,
      { encoding: 'utf8' },
    );
  } catch (err) {
    const e = err as { status?: number };
    if (e.status === 1) return [];
    throw err;
  }
  return grepOut
    .split('\n')
    .filter(Boolean)
    .filter((p) => !p.includes('__tests__'))
    .filter((p) => !p.endsWith('.spec.ts'))
    .filter((p) => !p.endsWith('.test.ts'))
    // ADR-030 day-one reset archived the pre-baseline migration chain into
    // <migrations>/.archive/<timestamp>/. Those files exist in git history
    // for forensic reference but are never executed — destructive DDL inside
    // them is not a production hazard. Treat the archive as out-of-scope.
    .filter((p) => !p.includes('/.archive/'));
}

function lineContext(src: string, matchIndex: number): string {
  const start = src.lastIndexOf('\n', matchIndex) + 1;
  const end = src.indexOf('\n', matchIndex);
  return src.slice(start, end === -1 ? undefined : end).trim();
}

/**
 * Heuristic: a line that starts with a comment marker (`*`, `//`, `/*`) is
 * a docblock or inline comment, NOT executable SQL. Skip such matches.
 *
 * This avoids false positives like the sensor-service outbox migration
 * whose docblock prose includes the literal text `DROP TABLE sensor.event_outbox CASCADE`
 * as documentation of what NOT to do.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('*') ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*')
  );
}

function isProtectedTarget(
  targetType: 'schema' | 'table',
  target: string,
): boolean {
  const lowered = target.toLowerCase();
  if (targetType === 'schema') {
    return (PROTECTED_SCHEMAS as readonly string[]).includes(lowered);
  }
  // table
  if ((PROTECTED_TABLES as readonly string[]).includes(lowered)) {
    return true;
  }
  return PROTECTED_TABLE_PATTERNS.some((p) => p.test(lowered));
}

describe('INVARIANT — protected-tables-guard (COMPLIANCE-CRITICAL-001)', () => {
  const files = listMigrationFiles();

  it('repository contains migration files to scan', () => {
    // Sanity-check that the scan surface is non-empty. After ADR-030's
    // day-one reset archived the pre-baseline chain into `.archive/`
    // (excluded above), 14 consolidated baselines + a handful of
    // post-reset add-ons remain. The threshold (>10) is a smoke
    // probe: if it drops to single digits we want to know.
    expect(files.length).toBeGreaterThan(10);
  });

  it('no NEW migration performs destructive DDL on a protected table/schema without -- COMPLIANCE-WAIVER:', () => {
    const violations: Violation[] = [];

    for (const relativePath of files) {
      if (GRANDFATHERED_HISTORICAL_MIGRATIONS.has(relativePath)) {
        continue;
      }

      const fullPath = resolve(REPO_ROOT, relativePath);
      const src = readFileSync(fullPath, 'utf8');

      // A waiver marker anywhere in the file exempts the file from the check.
      // Reviewers must verify the marker is justified by an ADR + CODEOWNERS.
      const hasWaiver = COMPLIANCE_WAIVER_MARKER_RE.test(src);
      if (hasWaiver) {
        continue;
      }

      // Scope the scan to the up()-direction body. Down() rollback DROPs are
      // structurally correct (CREATE → DROP inverse) and not the regression
      // class this guard protects against.
      const downStart = findDownMethodStart(src);
      const upBody = src.slice(0, downStart);

      for (const { name, re, targetType } of DESTRUCTIVE_PATTERNS) {
        re.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = re.exec(upBody)) !== null) {
          const target = match[1];
          if (!target) continue;
          if (!isProtectedTarget(targetType, target)) continue;

          const excerpt = lineContext(upBody, match.index);
          // Skip docblock / comment lines — these are documentation, not executable SQL.
          if (isCommentLine(excerpt)) continue;

          violations.push({
            file: relativePath,
            pattern: name,
            target,
            excerpt,
          });
        }
      }
    }

    if (violations.length > 0) {
      const detail = violations
        .map(
          (v) =>
            `  - ${v.file}\n      pattern: ${v.pattern}\n      target:  ${v.target}\n      line:    ${v.excerpt}`,
        )
        .join('\n');
      throw new Error(
        `Protected-tables guard violated:\n${detail}\n\n` +
          `Resolution:\n` +
          `  1. Verify the operation is truly necessary on a compliance-critical table.\n` +
          `  2. Add a comment in the migration body:\n` +
          `       -- COMPLIANCE-WAIVER: <finding-id> <reason>\n` +
          `  3. Obtain CODEOWNERS approval from compliance-expert + security-reviewer.\n` +
          `  4. Land an ADR documenting the invariant relaxation.\n` +
          `  5. Re-run this invariant — the waiver marker exempts the file.`,
      );
    }

    expect(violations).toHaveLength(0);
  });

  it('PROTECTED_TABLES SSoT is non-empty and lowercased', () => {
    expect(PROTECTED_TABLES.length).toBeGreaterThan(10);
    for (const t of PROTECTED_TABLES) {
      expect(t).toBe(t.toLowerCase());
      expect(t).toMatch(/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/);
    }
  });

  it('PROTECTED_SCHEMAS includes auth + shared + event_store (canonical compliance-critical schemas)', () => {
    expect([...PROTECTED_SCHEMAS]).toEqual(
      expect.arrayContaining(['auth', 'shared', 'event_store']),
    );
  });
});
