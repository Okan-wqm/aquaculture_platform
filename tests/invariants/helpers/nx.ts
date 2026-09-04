/**
 * Nx project-graph queries — shared SSoT for the invariants that ask
 * "which projects declare target X?", "does project P exist?" or "what does P
 * declare?".
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
 * One `nx graph --file` call answers every question below; it is memoised for
 * the life of the Jest worker. Runs with the daemon off and Nx Cloud off,
 * mirroring CI.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Repo root, resolved from this file's location (tests/invariants/helpers). */
export const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const NX_TARGET_NAME = /^[A-Za-z0-9:_-]+$/;

export interface NxTargetDefinition {
  readonly executor?: string;
  readonly [key: string]: unknown;
}

export interface NxProjectNode {
  readonly name: string;
  /** Repo-relative project root, no trailing slash. */
  readonly root: string;
  readonly targets: Readonly<Record<string, NxTargetDefinition>>;
}

interface NxGraphFile {
  readonly graph: {
    readonly nodes: Record<
      string,
      {
        readonly data: {
          readonly root: string;
          readonly targets?: Record<string, NxTargetDefinition>;
        };
      }
    >;
  };
}

let graphCache: ReadonlyMap<string, NxProjectNode> | undefined;

function projectGraph(): ReadonlyMap<string, NxProjectNode> {
  if (graphCache !== undefined) return graphCache;
  const dir = mkdtempSync(join(tmpdir(), 'nx-graph-invariants-'));
  const file = join(dir, 'graph.json');
  try {
    execFileSync('npx', ['nx', 'graph', `--file=${file}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' },
    });
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as NxGraphFile;
    const nodes = new Map<string, NxProjectNode>();
    for (const [name, node] of Object.entries(parsed.graph.nodes)) {
      nodes.set(name, {
        name,
        root: node.data.root.replace(/\/$/, ''),
        targets: node.data.targets ?? {},
      });
    }
    if (nodes.size === 0) throw new Error('nx graph produced an empty project graph');
    graphCache = nodes;
    return nodes;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every project name in the workspace, sorted. */
export function nxProjects(): readonly string[] {
  return [...projectGraph().keys()].sort();
}

/** The project node for `name`. Throws for an unknown project. */
export function nxProjectDetail(name: string): NxProjectNode {
  const node = projectGraph().get(name);
  if (node === undefined) throw new Error(`Unknown Nx project: ${JSON.stringify(name)}`);
  return node;
}

/** Repo-relative root directory of `name` (no trailing slash). */
export function nxProjectRoot(name: string): string {
  return nxProjectDetail(name).root;
}

/** Project names declaring `target` (inferred or explicit), sorted. Empty for a phantom target. */
export function nxProjectsWithTarget(target: string): readonly string[] {
  if (!NX_TARGET_NAME.test(target)) {
    throw new Error(`Not an Nx target name: ${JSON.stringify(target)}`);
  }
  return nxProjects().filter((name) => target in nxProjectDetail(name).targets);
}
