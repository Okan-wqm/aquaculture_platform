/**
 * APA-130 — a PostgreSQL `date` column may never be declared as a `Date`.
 *
 * TypeORM's `PostgresDriver.prepareHydratedValue` normalizes a `date` column to
 * a 'YYYY-MM-DD' STRING (`DateUtils.mixedDateToDateString`) *before* any column
 * transformer runs. An entity that annotates such a property as `Date` is
 * therefore an unchecked lie: the compiler accepts `.toISOString()` /
 * `.getFullYear()` / `.getMonth()`, and every one of those calls throws
 * `TypeError: x.toISOString is not a function` the moment a row exists. That is
 * exactly how three SUPER_ADMIN analytics trend endpoints shipped: green on an
 * empty database, 500 on the first snapshot the daily cron wrote.
 *
 * The cure is `DateOnlyColumn()` in `@aquaculture/backend-common/database`,
 * which declares the property as the branded `IsoDateString` — matching driver
 * reality, removing the timezone ambiguity a `Date` carries for a value that
 * has no time, and turning every Date-method call into a COMPILE error. It
 * emits identical DDL, so adopting it needs no migration.
 *
 * # WHY A FROZEN INVENTORY RATHER THAN A CLEAN BAN
 *
 * The same latent lie exists at 94 sites across farm-service, hr-service and
 * billing-service. Retyping them cascades through services, DTOs, GraphQL
 * resolvers and fixtures in each of those bounded contexts — it is a separate,
 * per-service migration, not a line item on an admin-panel fix. That work is
 * tracked as PLAT-HIGH-902 with an owner and a deadline; this gate makes
 * the debt countable and, critically, makes it impossible to GROW:
 *
 *   * a `date` column that is NOT in the baseline fails the build, so every new
 *     one must use `DateOnlyColumn()`;
 *   * a baseline entry that no longer exists ALSO fails, forcing the entry to
 *     be deleted — the list can only shrink, never silently go stale.
 *
 * Tier-3 make-detectable. Runs on every PR via the `invariants:fast` shard.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-130
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const BASELINE: {
  readonly finding: string;
  readonly sites: readonly string[];
} = JSON.parse(readFileSync(resolve(__dirname, 'date-column-legacy-baseline.json'), 'utf-8'));

/** Entity source lives under these roots; `platform/**` is scanned for completeness. */
const TRACKED_GLOBS = ['apps', 'libs', 'platform'] as const;

/**
 * Migrations carry raw DDL strings, not entity metadata, and test/fixture files
 * describe shapes rather than declare persistence — neither can mis-hydrate.
 */
const EXEMPT_PATH_PATTERNS = [
  /\/migrations\//,
  /__tests__\//,
  /__mocks__\//,
  /\.spec\.ts$/,
  /\.test\.ts$/,
  /\.d\.ts$/,
] as const;

/** `@Column({ ... type: 'date' ... })` and its `@PrimaryColumn` sibling. */
const DATE_COLUMN_RE = /@(?:Primary)?Column\(\{[^}]*type:\s*'date'[^}]*\}\)/;

/** `name!: Type` / `name?: Type` / `readonly name: Type` on the decorated property. */
const PROPERTY_RE = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)[!?]?\s*:\s*([^;=]+)/;

interface Site {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly declaredType: string;
}

function listTrackedFiles(): readonly string[] {
  const args = ['ls-files', '-z', '--', ...TRACKED_GLOBS.map((g) => `${g}/**/*.ts`)];
  const out = execSync(`git ${args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')}`, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((p) => existsSync(resolve(REPO_ROOT, p)))
    .filter((p) => !EXEMPT_PATH_PATTERNS.some((rx) => rx.test(p)));
}

/**
 * Find every `date` column whose property is declared as a `Date`. A property
 * declared any other way (`IsoDateString` via `DateOnlyColumn`, or a plain
 * `string`) matches driver reality and is not a hit.
 */
function scanFile(file: string): readonly Site[] {
  const lines = readFileSync(resolve(REPO_ROOT, file), 'utf-8').split(/\r?\n/);
  const sites: Site[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!DATE_COLUMN_RE.test(lines[i] ?? '')) continue;
    // The decorator may be followed by further decorators or blank lines before
    // the property itself; take the first line that parses as a declaration.
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const m = PROPERTY_RE.exec(lines[j] ?? '');
      if (!m) continue;
      const [, name = '', declaredType = ''] = m;
      if (/\bDate\b/.test(declaredType)) {
        sites.push({ id: `${file}#${name}`, file, line: j + 1, declaredType: declaredType.trim() });
      }
      break;
    }
  }
  return sites;
}

describe('INVARIANT: `date` columns are never declared as `Date` (APA-130)', () => {
  const found = listTrackedFiles().flatMap((f) => [...scanFile(f)]);
  const baseline = new Set(BASELINE.sites);

  it('no NEW date column is declared as a Date — use DateOnlyColumn()', () => {
    const added = found.filter((s) => !baseline.has(s.id));
    if (added.length > 0) {
      const list = added.map((s) => `  ${s.file}:${s.line}  ${s.id} : ${s.declaredType}`).join('\n');
      throw new Error(
        `${added.length} new PostgreSQL \`date\` column(s) declared as \`Date\`:\n${list}\n\n` +
          `TypeORM hydrates a \`date\` column as a 'YYYY-MM-DD' STRING, so this ` +
          `annotation is a lie the compiler cannot catch — \`.toISOString()\` ` +
          `compiles and throws in production (APA-130).\n\n` +
          `Fix: replace the decorator with \`DateOnlyColumn()\` from ` +
          `\`@aquaculture/backend-common/database\` and declare the property as ` +
          `\`IsoDateString\`. Identical DDL, no migration needed.`,
      );
    }
    expect(added).toEqual([]);
  });

  it('the legacy baseline shrinks only — stale entries must be deleted', () => {
    const live = new Set(found.map((s) => s.id));
    const stale = BASELINE.sites.filter((id) => !live.has(id));
    if (stale.length > 0) {
      throw new Error(
        `${stale.length} baseline entr(y/ies) in ` +
          `tests/invariants/date-column-legacy-baseline.json no longer exist:\n` +
          `${stale.map((s) => `  ${s}`).join('\n')}\n\n` +
          `These sites were converted (or removed) — delete them from the ` +
          `baseline so the ratchet tightens and the remaining ` +
          `${BASELINE.finding} debt stays honestly counted.`,
      );
    }
    expect(stale).toEqual([]);
  });

  it('admin-api-service — the service APA-130 fixed — carries zero legacy sites', () => {
    const regressions = found.filter((s) => s.file.startsWith('apps/admin-api-service/'));
    expect(regressions.map((s) => `${s.file}:${s.line} ${s.id}`)).toEqual([]);
  });
});
