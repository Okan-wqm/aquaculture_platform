/**
 * Invariant — no source file imports from the bare root barrels of
 * `@aquaculture/backend-common` or `@platform/backend-common`. Every
 * import must use a per-subtree path (`@aquaculture/backend-common/
 * <subtree>` — `/auth`, `/audit`, `/database`, `/utils`, `/nats`, …).
 *
 * # Why this exists (the architectural gap it closes)
 *
 * The platform's primary defence is the ESLint `no-restricted-imports`
 * rule in `.eslintrc.json:86-99`, which bans the two root paths and
 * directs callers to the per-subtree alias. On a clean
 * `npm run lint:all` the rule fires correctly. The codemod
 * (commit `810eae97` — AUDIT-MEDIUM-005 phase 2) migrated the
 * existing root-barrel users into per-subtree imports, then phase 3
 * (commit `34a67d44`) wired the rule.
 *
 * However, CI's PR-time lint runs as `nx affected -t lint` — only
 * projects whose dependency graph the diff touched. Between weekly
 * `ci-full.yml` runs (which DO use `lint:all`), drift is invisible.
 *
 * This is the EXACT same architectural class as
 * `no-direct-getrepository-call.spec.ts` (Tier-3 detector for
 * `no-restricted-syntax`). PR #159's commit `fce98510` cleaned up
 * 13 files that had accumulated since AUDIT-MEDIUM-005 phase 2;
 * without this Tier-3 detector the same drift restarts the moment
 * any future PR touches a service that imports from
 * `@aquaculture/backend-common` (root) without touching that service's
 * project.json — and `nx affected` does not see the violation.
 *
 * # Tier classification
 *
 * Tier-3 make-detectable. Companion to:
 *   - the ESLint rule itself (the AST-level catcher, when ESLint runs)
 *   - `eslint-rule-presence.spec.ts` (config-drift detector — rule
 *     deletion class)
 *   - `no-direct-getrepository-call.spec.ts` (the parallel Tier-3
 *     detector for the `no-restricted-syntax` rule)
 *
 * The four-layer defence catches every known evasion path of the
 * lint-scope class:
 *
 *   |               | Rule deleted | Imports drift in | Lint scope wrong |
 *   |---------------|--------------|------------------|------------------|
 *   | eslint rule   |     —        |    ✓ catches     |       —          |
 *   | rule-presence |  ✓ catches   |        —         |       —          |
 *   | (this file)   |  ✓ catches   |    ✓ catches     |    ✓ catches     |
 *
 * # What this invariant does NOT enforce
 *
 *   - It does not assert that the per-subtree path matches the symbol's
 *     canonical location. A future commit that mis-routes an import
 *     (`tenantManagerRepo` from `/auth` instead of `/database`) would
 *     fail `tsc` first; the type-check is the upstream defence.
 *   - It does not ban the root path inside `__tests__/` / `__mocks__/` /
 *     `*.spec.ts` / `*.test.ts`. Tests legitimately deep-import from
 *     the root for fixture-shape reasons.
 *
 * # Bypass policy
 *
 * No bypass. There is no legitimate runtime reason to import from the
 * root barrel — the per-subtree alias resolves to the exact same
 * symbol but lets bundlers + Nx caches invalidate at subtree
 * granularity (1 of 25 subtrees) instead of root granularity (every
 * subtree). If a future need genuinely arises, it would be an ADR
 * change on AUDIT-MEDIUM-005's premise, not an inline exemption.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Source globs we sweep. Mirrors the path scope of the ESLint rule
 * in `.eslintrc.json` (the rule sits in the `*.ts, *.tsx` override).
 * Web is not currently importing from `@aquaculture/backend-common`
 * (frontend has its own barrel sets) but is included for safety —
 * if a web file ever does, it would hit the same lint-scope class.
 */
const TRACKED_GLOBS = ['apps', 'libs', 'platform', 'web'] as const;

/**
 * Test-shape paths the rule exempts. Tests routinely deep-import
 * implementation details by exact path for mock/spy purposes; the
 * runtime invariant is what production code does, not what fixtures do.
 */
const EXEMPT_PATH_PATTERNS = [
  /__tests__\//,
  /__mocks__\//,
  /\.spec\.ts$/,
  /\.test\.ts$/,
  /\.spec\.tsx$/,
  /\.test\.tsx$/,
  /\.e2e\.ts$/,
  /\.e2e-spec\.ts$/,
  /\.d\.ts$/,
  /\/test\//,
] as const;

interface Hit {
  file: string;
  line: number;
  text: string;
  banned: string;
}

function listTrackedFiles(): readonly string[] {
  const args = [
    'ls-files',
    '-z',
    '--',
    ...TRACKED_GLOBS.flatMap((g) => [`${g}/**/*.ts`, `${g}/**/*.tsx`]),
  ];
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
 * Two banned root specifiers. The trailing single quote / double
 * quote / closing-grouping marker is required so `@aquaculture/
 * backend-common/database` does NOT match — the regex ends at the
 * closing string delimiter.
 *
 * Both `import` and `export` re-export forms are caught:
 *   import X from '@aquaculture/backend-common';
 *   import X from "@aquaculture/backend-common";
 *   export * from '@aquaculture/backend-common';
 *   export { X } from '@aquaculture/backend-common';
 *
 * The patterns deliberately do NOT match `import type` either — the
 * Nx cache invalidation argument applies regardless of whether the
 * import is type-only (TypeScript still reads the module's type
 * declaration file out of the root barrel and re-builds when any
 * subtree changes).
 */
const BANNED_SPECIFIERS = ['@aquaculture/backend-common', '@platform/backend-common'] as const;

/**
 * Match `from '<spec>'` and `from "<spec>"` with a closing quote
 * immediately after the specifier — i.e. NOT followed by `/<subtree>`.
 * The ` ` (space) requirement before `from` excludes substring
 * matches inside JSDoc / strings that happen to spell the path.
 */
const ROOT_IMPORT_REGEXES = BANNED_SPECIFIERS.map(
  (spec) =>
    new RegExp(
      // capture the surrounding `from '<spec>'` / `from "<spec>"`
      `\\s+from\\s+['"]${spec.replace(/[/.]/g, '\\$&')}['"]`,
    ),
);

function scanFile(file: string): readonly Hit[] {
  const path = resolve(REPO_ROOT, file);
  const lines = readFileSync(path, 'utf-8').split(/\r?\n/);
  const hits: Hit[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const [index, re] of ROOT_IMPORT_REGEXES.entries()) {
      const banned = BANNED_SPECIFIERS[index];
      if (!banned) continue;
      if (re.test(line)) {
        // Skip line-comment lines — `// some doc that mentions
        // @aquaculture/backend-common` is documentation, not a real
        // import. Real `import` / `export` statements never start
        // with `//`.
        if (line.trim().startsWith('//')) continue;
        if (line.trim().startsWith('*')) continue; // jsdoc continuation
        if (line.trim().startsWith('/*')) continue; // jsdoc opener
        hits.push({
          file,
          line: i + 1,
          text: line.trim().slice(0, 120),
          banned,
        });
      }
    }
  }
  return hits;
}

describe('INVARIANT: no source file imports from the bare root barrel of @aquaculture/backend-common or @platform/backend-common', () => {
  const files = listTrackedFiles();
  const allHits: Hit[] = files.flatMap((f) => [...scanFile(f)]);

  it('every import uses a per-subtree path, never the bare root', () => {
    if (allHits.length > 0) {
      const grouped = new Map<string, Hit[]>();
      for (const h of allHits) {
        const list = grouped.get(h.file) ?? [];
        list.push(h);
        grouped.set(h.file, list);
      }
      const sorted = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const lines = sorted
        .map(([file, hs]) => {
          const callLines = hs
            .map((h) => `      L${h.line}  ${h.banned}\n        > ${h.text}`)
            .join('\n');
          return `  ${file} (${hs.length})\n${callLines}`;
        })
        .join('\n\n');
      throw new Error(
        `${allHits.length} root-barrel import(s) in ${grouped.size} file(s):\n${lines}\n\n` +
          `The root barrel aggregates ~25 subtrees; importing it forces ` +
          `every consumer to re-invalidate on any change to any subtree. ` +
          `Replace each import with the per-subtree alias:\n` +
          `  '@aquaculture/backend-common'  →  '@aquaculture/backend-common/<subtree>'\n` +
          `  '@platform/backend-common'     →  '@aquaculture/backend-common/<subtree>'   (canonical alias)\n\n` +
          `Subtree set: /auth, /audit, /ai-safety, /bootstrap, /config, /constants, ` +
          `/context, /database, /decorators, /guards, /health, ` +
          `/mobile-command, /nats, /pagination, /redis, /utils  (full list in tsconfig.base.json paths). ` +
          `If your import target is genuinely not in any subtree, add it to a subtree ` +
          `rather than re-introducing the root barrel.`,
      );
    }
    expect(allHits).toEqual([]);
  });
});
