/**
 * Nx project-graph queries — shared SSoT for the invariants that ask
 * "which projects declare target X?" or "does project P exist?".
 *
 * Why one module (2026-09-04, INFRA-HIGH-141): three specs each shelled out to
 * `nx show projects` with their own env, their own JSON parsing and no cache.
 * The phantom-target defect (`ci-affected.yml` fanning out to `test:invariant`
 * and `type-check`, which no project declares) lived in the seam between
 * workflow text and the project graph, and the only way to close that seam
 * honestly is to ask Nx — a static scan of project.json/package.json would
 * re-implement target inference (`nx.includedScripts`, plugin targets,
 * project.json-over-package.json naming) and drift from it.
 *
 * Every call runs with the daemon off and Nx Cloud off, mirroring CI.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Repo root, resolved from this file's location (tests/invariants/helpers). */
export const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const NX_TARGET_NAME = /^[A-Za-z0-9:_-]+$/;
const NX_PROJECT_NAME = /^[A-Za-z0-9@/._-]+$/;

function nx(args: readonly string[]): string {
  return execFileSync('npx', ['nx', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' },
  });
}

const projectsCache = new Map<string, readonly string[]>();

function projects(target: string | undefined): readonly string[] {
  const key = target ?? '';
  const cached = projectsCache.get(key);
  if (cached !== undefined) return cached;
  const args = ['show', 'projects', '--json'];
  if (target !== undefined) args.push(`--with-target=${target}`);
  const parsed = JSON.parse(nx(args)) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((name) => typeof name === 'string')) {
    throw new Error(`nx show projects returned a non-string-array for ${key || '(all)'}`);
  }
  const names: readonly string[] = [...parsed].sort();
  projectsCache.set(key, names);
  return names;
}

/** Every project name in the workspace, sorted. */
export function nxProjects(): readonly string[] {
  return projects(undefined);
}

/** Project names declaring `target` (inferred or explicit), sorted. Empty for a phantom target. */
export function nxProjectsWithTarget(target: string): readonly string[] {
  if (!NX_TARGET_NAME.test(target)) {
    throw new Error(`Not an Nx target name: ${JSON.stringify(target)}`);
  }
  return projects(target);
}

interface NxProjectDetail {
  readonly root: string;
  readonly targets?: Readonly<Record<string, unknown>>;
}

const detailCache = new Map<string, NxProjectDetail>();

/** `nx show project <name> --json`, memoised. Throws for an unknown project. */
export function nxProjectDetail(name: string): NxProjectDetail {
  if (!NX_PROJECT_NAME.test(name)) {
    throw new Error(`Not an Nx project name: ${JSON.stringify(name)}`);
  }
  const cached = detailCache.get(name);
  if (cached !== undefined) return cached;
  const parsed = JSON.parse(nx(['show', 'project', name, '--json'])) as Partial<NxProjectDetail>;
  if (typeof parsed.root !== 'string') {
    throw new Error(`nx show project ${name} returned no root`);
  }
  const detail: NxProjectDetail = {
    root: parsed.root.replace(/\/$/, ''),
    ...(parsed.targets === undefined ? {} : { targets: parsed.targets }),
  };
  detailCache.set(name, detail);
  return detail;
}

/** Repo-relative root directory of `name` (no trailing slash). */
export function nxProjectRoot(name: string): string {
  return nxProjectDetail(name).root;
}
