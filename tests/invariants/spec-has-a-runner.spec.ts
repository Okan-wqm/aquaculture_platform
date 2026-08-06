/**
 * Every spec file must be reachable by something that runs it.
 *
 * # Why this exists
 *
 * An audit of one day's merges found three test files that nobody executes:
 * `libs/backend-common/src/metrics/__tests__/cron-heartbeat.service.spec.ts`,
 * `platform/libs/outbox/src/__tests__/outbox-relay-liveness.spec.ts`, and
 * `tools/supervisor/runtime-supervisor.spec.ts`. Each was written, reviewed
 * and merged green — and its greenness carried no information, because no
 * command in the repository could reach it.
 *
 * The mechanism was always the same: a directory ships a working
 * `jest.config` but no `project.json`, so Nx does not see a project, so
 * `affected` and `run-many` both skip it. `libs/backend-common` had been in
 * that state long enough to accumulate **1,359 tests that had never run in
 * CI** — in the library every service depends on.
 *
 * Worse than invisible: those directories sit inside `nx.json`'s
 * `sharedGlobals`, so touching them marks all 42 test projects affected. CI
 * did maximum work and still ran none of their specs.
 *
 * # What this asserts
 *
 * For every `*.spec.*` file outside the runners' own trees, SOME declared
 * runner claims it: an Nx project with a `test` target whose root contains
 * it, or one of the explicitly-declared non-Nx runner globs below.
 *
 * A new spec in a new directory therefore fails here at authoring time
 * rather than passing silently forever.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const repoRoot = resolve(__dirname, '../..');

/**
 * Runners that are NOT Nx projects, each with the glob it owns and the npm
 * script that CI invokes. Adding a runner here is a deliberate act; the point
 * is that no spec may exist without one.
 */
const DECLARED_NON_NX_RUNNERS: ReadonlyArray<{
  readonly script: string;
  readonly owns: (relPath: string) => boolean;
}> = [
  {
    // package.json `tools:test`, invoked by .github/workflows/quality-gates.yml
    script: 'tools:test',
    owns: (p) => /^tools\/(supervisor|watchdog)\/[^/]+\.spec\.(ts|mjs)$/.test(p),
  },
  {
    // package.json `gates:*:test`, invoked by .github/workflows/closes-footer-check.yml
    script: 'gates:*:test',
    owns: (p) => /^tools\/gates\/[^/]+\.spec\.ts$/.test(p),
  },
  {
    // aria-kernel runs under python unittest in the aria-kernel workflows
    script: 'aria-kernel workflows',
    owns: (p) => p.startsWith('aria-kernel/'),
  },
  {
    // e2e specs run in their own workflows against a live environment
    script: 'e2e workflows',
    owns: (p) => p.startsWith('e2e/') || p.startsWith('tests/e2e/'),
  },
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.nx', '.claude']);

/**
 * Specs that have no runner TODAY, with the reason. This list may shrink and
 * may not grow — that is the whole contract. Each entry is a real gap, not an
 * exemption: the code is tested on someone's laptop and nowhere else.
 *
 * `web/apps/aquamobil` is an Nx project with lint/build/typecheck targets and
 * no `test` target at all, so its 18 specs have never run in CI. Wiring it
 * needs the mobile PWA's vitest/jest story settled, which is a bigger change
 * than this PR should carry.
 *
 * `tools/lint-gates` and `tools/worktree-audit` are ts-node CommonJS specs
 * like `tools/gates/**`, but without the npm scripts that make those
 * reachable; they need the same treatment as tools/gates rather than the
 * strip-types runner.
 */
const KNOWN_UNRUNNABLE_SPECS: ReadonlySet<string> = new Set([
  'web/apps/aquamobil',
  'tools/lint-gates',
  'tools/worktree-audit',
]);

function isKnownUnrunnable(relPath: string): boolean {
  for (const prefix of KNOWN_UNRUNNABLE_SPECS) {
    if (relPath.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

function walkSpecs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      walkSpecs(full, acc);
    } else if (/\.spec\.(ts|mts|mjs|cts)$/.test(entry)) {
      acc.push(relative(repoRoot, full).split(sep).join('/'));
    }
  }
  return acc;
}

interface NxProject {
  readonly root: string;
  readonly targets?: Record<string, unknown>;
}

function nxProjectRootsWithTestTarget(): string[] {
  const raw = execFileSync('npx', ['nx', 'show', 'projects', '--with-target=test', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NX_DAEMON: 'false' },
  });
  const names = JSON.parse(raw) as string[];
  const roots: string[] = [];
  for (const name of names) {
    const detail = execFileSync('npx', ['nx', 'show', 'project', name, '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, NX_DAEMON: 'false' },
    });
    const parsed = JSON.parse(detail) as NxProject;
    if (parsed.root) roots.push(parsed.root.replace(/\/$/, ''));
  }
  return roots;
}

describe('every spec has a runner', () => {
  it('leaves no spec file unreachable by any declared runner', () => {
    const specs = walkSpecs(repoRoot);
    expect(specs.length).toBeGreaterThan(100);

    const roots = nxProjectRootsWithTestTarget();
    const orphans = specs.filter((spec) => {
      if (DECLARED_NON_NX_RUNNERS.some((runner) => runner.owns(spec))) return false;
      if (isKnownUnrunnable(spec)) return false;
      return !roots.some((root) => spec === root || spec.startsWith(`${root}/`));
    });

    expect(orphans).toEqual([]);
  });

  it('keeps the unrunnable list honest — every entry still contains a spec', () => {
    // A ratchet that can be satisfied by stale entries is not a ratchet. If a
    // directory has been fixed or deleted, its exemption must go with it.
    const specs = walkSpecs(repoRoot);
    const stale = [...KNOWN_UNRUNNABLE_SPECS].filter(
      (prefix) => !specs.some((spec) => spec.startsWith(`${prefix}/`)),
    );

    expect(stale).toEqual([]);
  });

  it('keeps the non-Nx runner scripts real', () => {
    // A declared runner that does not exist is the same lie one level up.
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts['tools:test']).toBeDefined();
    expect(existsSync(join(repoRoot, '.github/workflows/quality-gates.yml'))).toBe(true);
    expect(readFileSync(join(repoRoot, '.github/workflows/quality-gates.yml'), 'utf8')).toContain(
      'npm run tools:test',
    );
  });
});
