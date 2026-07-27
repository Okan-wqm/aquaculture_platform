/**
 * production-graph-purity — the production dependency graph contains no build-time toolchain.
 * ============================================================================
 *
 * WHY THIS EXISTS
 *
 * `npm audit --audit-level=high --omit=dev` is the `security-audit` job
 * (`.github/workflows/ci-affected.yml`) and a hard `needs:` of `merge-gate`,
 * which is a required status check. It answers exactly one question: "does
 * anything we SHIP have a high advisory?" That answer is only meaningful if
 * the production half of the graph actually corresponds to what ships.
 *
 * It did not. Two manifest defects put the entire lint and bundler toolchain
 * into the production graph:
 *
 *   1. `tools/eslint-rules` and `tools/executors/cargo` were npm `workspaces`.
 *      npm has no notion of a dev workspace — every workspace edge is
 *      unconditionally production — so `eslint`, `@eslint/*` and
 *      `@typescript-eslint/*` were production dependencies of a repo that
 *      ships none of them.
 *   2. `vite-plugin-svgr` sat in `dependencies`, dragging `vite`, `rollup`,
 *      `esbuild` and `terser` in with it, even though its only consumer
 *      (`web/modules/sensor-module/package.json`) already declares it as a
 *      devDependency.
 *
 * The visible symptom was a permanently-red required gate: the ONLY high
 * advisory in the "production" graph was `brace-expansion` reached through
 * `eslint@9 -> minimatch@3`, i.e. a lint-toolchain advisory blocking every
 * PR to main (INFRA-HIGH-081). Reclassifying is not a way of hiding it — it
 * is the truthful graph, and it changed zero resolved versions (0 version
 * changes, 0 additions across 3,405 lock entries; only `dev` flags moved).
 *
 * WHY IT READS THE LOCKFILE AND NOT `npm ls`
 *
 * `package-lock.json` is the artifact `npm ci --omit=dev` obeys, so its
 * `dev` flags ARE the contract. Reading them makes this check hermetic,
 * deterministic, runnable before any install, and immune to a partially
 * installed or hand-edited `node_modules`. Shelling out to `npm ls --omit=dev`
 * would test the current machine instead of the committed contract.
 *
 * Note `npm ci --omit=dev --dry-run` is NOT a usable alternative: on npm
 * 10.9.7 it ignores `--omit=dev` in its reported diff.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const LOCK_PATH = resolve(REPO_ROOT, 'package-lock.json');
const PKG_PATH = resolve(REPO_ROOT, 'package.json');

/**
 * Packages that must never be reachable from the production graph.
 *
 * Each is build-time only: it runs on a developer machine or a CI runner, or
 * it produces an artifact, but it is never loaded by a running service or
 * shipped in a browser bundle. A `dev: true` flag on every node resolving to
 * one of these is what keeps `--omit=dev` honest.
 */
const BUILD_TIME_ONLY = [
  'eslint',
  '@eslint/config-array',
  '@eslint/eslintrc',
  '@eslint/js',
  '@typescript-eslint/eslint-plugin',
  '@typescript-eslint/parser',
  '@typescript-eslint/utils',
  'vite',
  'rollup',
  'esbuild',
  'terser',
  'jest',
  'ts-jest',
  'nx',
  'tsx',
  'prettier',
] as const;

/** Workspace globs that are build-time tooling and must not be npm workspaces. */
const NON_WORKSPACE_TOOLING = ['tools/eslint-rules', 'tools/executors/cargo'] as const;

interface LockEntry {
  readonly dev?: boolean;
  readonly link?: boolean;
  readonly resolved?: string;
}

interface Lockfile {
  readonly lockfileVersion: number;
  readonly packages: Record<string, LockEntry>;
}

function readLock(): Lockfile {
  const parsed: unknown = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Lockfile).packages !== 'object'
  ) {
    throw new Error('package-lock.json has no `packages` map — lockfileVersion >= 2 is required');
  }
  return parsed as Lockfile;
}

/**
 * Every lock path whose final `node_modules/<name>` segment is exactly `name`.
 * Matching on the last segment is what makes a nested copy
 * (`node_modules/a/node_modules/eslint`) count as well as a hoisted one.
 */
function nodesFor(lock: Lockfile, name: string): string[] {
  const suffix = `node_modules/${name}`;
  return Object.keys(lock.packages).filter((p) => p === suffix || p.endsWith(`/${suffix}`));
}

describe('production dependency graph purity', () => {
  const lock = readLock();
  const pkg: { workspaces?: readonly string[]; dependencies?: Record<string, string> } = JSON.parse(
    readFileSync(PKG_PATH, 'utf8'),
  );

  it('uses a lockfile format that records dev flags', () => {
    expect(lock.lockfileVersion).toBeGreaterThanOrEqual(2);
    expect(Object.keys(lock.packages).length).toBeGreaterThan(1000);
  });

  it.each(BUILD_TIME_ONLY)('keeps every %s node out of the production graph', (name) => {
    const nodes = nodesFor(lock, name);
    // A package absent from the tree is trivially pure; the assertion is about
    // present nodes being dev-flagged.
    const productionNodes = nodes.filter((p) => lock.packages[p]?.dev !== true);
    expect(productionNodes).toEqual([]);
  });

  it('does not declare build-time tooling as npm workspaces', () => {
    const workspaces = pkg.workspaces ?? [];
    for (const tooling of NON_WORKSPACE_TOOLING) {
      // npm has no dev-workspace concept: a workspace entry is always a
      // production edge, which is exactly how the eslint toolchain got in.
      expect(workspaces).not.toContain(tooling);
    }
  });

  it('keeps the two tooling packages installed as build-time file: dependencies', () => {
    // Removing them from `workspaces` must not orphan them — Nx and
    // eslint.config.mjs both resolve `eslint-plugin-aquaculture` by name, so
    // the symlink has to keep existing via a devDependency.
    for (const tooling of NON_WORKSPACE_TOOLING) {
      const entry = lock.packages[tooling];
      expect(entry).toBeDefined();
      expect(entry?.dev).toBe(true);
    }
  });

  it('keeps vite-plugin-svgr out of production dependencies', () => {
    // Its sole consumer, web/modules/sensor-module, declares it as a
    // devDependency; a root `dependencies` entry pulled the whole bundler
    // toolchain into every backend image.
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('vite-plugin-svgr');
  });
});
