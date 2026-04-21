#!/usr/bin/env ts-node
/**
 * migration-codeowners-coverage — Phase 4.5 separation-of-duties gate.
 * ============================================================================
 *
 * Asserts that every on-disk path the db-migrate pipeline cares about is
 * covered by at least one CODEOWNERS rule. SOC2 CC6.1 separation of
 * duties requires author != reviewer on deploy-load-bearing files;
 * GitHub enforces "reviewer is a codeowner" via CODEOWNERS, so the
 * first requirement is that every such path HAS an owner rule at all.
 *
 * # What counts as "migration path"?
 *
 *   1. apps/<svc>/src/database/migrations/*.ts      (per-service migrations)
 *   2. libs/backend-common/src/database/schema-primitives/*.ts
 *   3. libs/backend-common/src/database/schema-drift/*.ts
 *   4. libs/backend-common/src/database/base-migration.ts
 *   5. libs/backend-common/src/database/schema-drift-validator.service.ts
 *
 * The gate globs the actual filesystem, then asks: is every discovered
 * path matched by at least one CODEOWNERS rule? (GitHub's CODEOWNERS
 * semantics: last matching rule wins, but we just need coverage >= 1.)
 *
 * # Exit codes
 *
 *   0 — every migration path is covered
 *   1 — one or more paths have no CODEOWNERS entry
 *   2 — input error
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

// Repo root resolution — this file lives at tools/gates/, go up two
// levels. Uses __dirname (CommonJS) OR process.cwd() fallback so the
// script works under both ts-node-esm (CLI direct invocation) and
// ts-jest (imported as a module with module:commonjs).
const SCRIPT_DIR = __dirname;
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const CODEOWNERS_PATH = resolve(REPO_ROOT, '.github', 'CODEOWNERS');

/** Recursive file walk with include/exclude globs. Bounded, no node_modules. */
function walkFiles(
  dir: string,
  accept: (path: string) => boolean,
): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, accept));
    } else if (entry.isFile() && accept(full)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Minimal CODEOWNERS pattern matcher — covers the subset this repo's
 * .github/CODEOWNERS actually uses.
 * Supports:
 *   - trailing-slash directory rules (matches any descendant)
 *   - `*` glob (single path component)
 *   - `**` glob (cross-component)
 *   - literal file paths
 * Unsupported subtleties (character classes, negation) aren't used by
 * this repo; rules below are straightforward prefix matches.
 */
function patternToRegex(pattern: string): RegExp {
  // Strip leading slash (CODEOWNERS paths are repo-relative).
  let p = pattern.replace(/^\//, '');
  // Escape regex specials EXCEPT our wildcard markers.
  p = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  // Replace `**` before `*` so the single-star path doesn't eat doubles.
  p = p.replace(/\*\*/g, '<<DOUBLESTAR>>');
  p = p.replace(/\*/g, '[^/]*');
  p = p.replace(/<<DOUBLESTAR>>/g, '.*');
  // Trailing slash → directory rule (match anything underneath).
  if (p.endsWith('/')) {
    p = p + '.*';
  }
  return new RegExp(`^${p}$`);
}

function loadCodeownersPatterns(): RegExp[] {
  const raw = readFileSync(CODEOWNERS_PATH, 'utf8');
  const patterns: RegExp[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    // First token is the path pattern.
    const token = trimmed.split(/\s+/)[0];
    if (!token) continue;
    patterns.push(patternToRegex(token));
  }
  return patterns;
}

function collectMigrationPaths(): string[] {
  const accept = (p: string): boolean => {
    const rel = relative(REPO_ROOT, p);
    if (rel.match(/^apps\/[^/]+\/src\/database\/migrations\/.*\.ts$/)) return true;
    if (rel.match(/^libs\/backend-common\/src\/database\/schema-primitives\/.*\.ts$/)) return true;
    if (rel.match(/^libs\/backend-common\/src\/database\/schema-drift\/.*\.ts$/)) return true;
    if (rel === 'libs/backend-common/src/database/base-migration.ts') return true;
    if (rel === 'libs/backend-common/src/database/schema-drift-validator.service.ts') return true;
    return false;
  };
  const roots = [
    resolve(REPO_ROOT, 'apps'),
    resolve(REPO_ROOT, 'libs', 'backend-common', 'src', 'database'),
  ];
  const paths: string[] = [];
  for (const r of roots) paths.push(...walkFiles(r, accept));
  // Deduplicate + to repo-relative + stable order.
  return Array.from(new Set(paths.map((p) => relative(REPO_ROOT, p)))).sort();
}

export function main(argv: readonly string[]): number {
  const jsonMode = argv.includes('--json');
  if (!existsSync(CODEOWNERS_PATH)) {
    process.stderr.write(
      `[migration-codeowners-coverage] CODEOWNERS file missing at ${CODEOWNERS_PATH}\n`,
    );
    return 2;
  }
  const patterns = loadCodeownersPatterns();
  const paths = collectMigrationPaths();
  if (paths.length === 0) {
    process.stderr.write(
      `[migration-codeowners-coverage] no migration paths found — repo layout mismatch?\n`,
    );
    return 2;
  }
  const uncovered: string[] = [];
  for (const p of paths) {
    const covered = patterns.some((re) => re.test(p));
    if (!covered) uncovered.push(p);
  }
  if (jsonMode) {
    process.stdout.write(
      JSON.stringify(
        {
          totalPaths: paths.length,
          uncoveredCount: uncovered.length,
          uncovered,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stdout.write(
      `migration-codeowners-coverage: ${paths.length} migration path(s) scanned, ${uncovered.length} uncovered.\n`,
    );
    if (uncovered.length > 0) {
      process.stdout.write('\n── UNCOVERED ──\n');
      for (const u of uncovered) process.stdout.write(`  ${u}\n`);
      process.stdout.write(
        '\n✗ Phase 4.5 separation-of-duties requires CODEOWNERS coverage on every migration path. Add an entry to .github/CODEOWNERS.\n',
      );
    } else {
      process.stdout.write('✓ All migration paths are CODEOWNERS-covered.\n');
    }
  }
  return uncovered.length === 0 ? 0 : 1;
}

// "If this file was invoked directly as the entry" check. Works in
// both ts-node CLI (direct invocation) and ts-jest (imported as a
// module — argv[1] is then jest's worker, not this file).
if (process.argv[1]?.endsWith('migration-codeowners-coverage.ts')) {
  process.exit(main(process.argv.slice(2)));
}
