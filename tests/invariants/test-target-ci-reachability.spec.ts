/**
 * Every executable test authority must be reachable from CI, and every
 * test-family target driven by CI must exist. Nx legitimately succeeds when an
 * affected target selects no projects, so neither half can be inferred from a
 * green workflow alone.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

const WATCH_MODE_TARGETS: Readonly<Record<string, string>> = Object.freeze({
  'test:watch': 'interactive watch targets must never be started by CI',
});

interface ProjectTarget {
  readonly project: string;
  readonly target: string;
  readonly command: string;
}

interface RootScript {
  readonly name: string;
  readonly body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function workflowSources(): ReadonlyMap<string, string> {
  return new Map(
    readdirSync(WORKFLOW_DIR)
      .filter((entry) => entry.endsWith('.yml') || entry.endsWith('.yaml'))
      .map((entry) => [entry, readFileSync(join(WORKFLOW_DIR, entry), 'utf8')]),
  );
}

/** Read the target surface from Nx itself; hand-scanning manifests misses inference. */
function declaredTestTargets(): ProjectTarget[] {
  const graphFile = join(tmpdir(), `nx-test-target-reachability-${process.pid}.json`);
  execFileSync(
    'node',
    ['tools/toolchain/run.mjs', 'nx', 'graph', `--file=${graphFile}`],
    {
      cwd: REPO_ROOT,
      stdio: 'ignore',
      env: { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' },
    },
  );

  try {
    const document: unknown = JSON.parse(readFileSync(graphFile, 'utf8'));
    if (!isRecord(document) || !isRecord(document.graph) || !isRecord(document.graph.nodes)) {
      throw new Error('Nx graph did not expose graph.nodes');
    }

    const targets: ProjectTarget[] = [];
    for (const [project, node] of Object.entries(document.graph.nodes)) {
      if (!isRecord(node) || !isRecord(node.data) || !isRecord(node.data.targets)) continue;
      for (const [target, definition] of Object.entries(node.data.targets)) {
        if (target !== 'test' && !target.startsWith('test:')) continue;
        targets.push({ project, target, command: JSON.stringify(definition) });
      }
    }
    return targets;
  } finally {
    rmSync(graphFile, { force: true });
  }
}

function ciDrivenTargets(sources: ReadonlyMap<string, string>): ReadonlyMap<string, string[]> {
  const driven = new Map<string, string[]>();
  for (const [file, source] of sources) {
    for (const match of source.matchAll(
      /affected-target-policy\.sh\s+--target\s+([\w:.-]+)/g,
    )) {
      const target = match[1];
      if (!target) continue;
      driven.set(target, [...(driven.get(target) ?? []), file]);
    }
  }
  return driven;
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function targetIsDirectlyReachable(
  entry: ProjectTarget,
  driven: ReadonlyMap<string, string[]>,
  sources: ReadonlyMap<string, string>,
): boolean {
  if (driven.has(entry.target)) return true;
  const directForms = [
    `nx run ${entry.project}:${entry.target}`,
    `nx ${entry.target} ${entry.project}`,
    `run ${entry.target}`,
  ];
  return [...sources.values()].some((source) =>
    directForms.some((form) => source.includes(form)),
  );
}

function targetDelegatesFromReachableSibling(
  entry: ProjectTarget,
  declared: readonly ProjectTarget[],
  driven: ReadonlyMap<string, string[]>,
  sources: ReadonlyMap<string, string>,
): boolean {
  return declared.some(
    (sibling) =>
      sibling.project === entry.project &&
      sibling.target !== entry.target &&
      sibling.command.includes(entry.target) &&
      targetIsDirectlyReachable(sibling, driven, sources),
  );
}

function rootTestScripts(): RootScript[] {
  const document: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  if (!isRecord(document) || !isRecord(document.scripts)) {
    throw new Error('Root package.json has no scripts authority');
  }
  return Object.entries(document.scripts)
    .filter(([name]) => name === 'test' || name.startsWith('test:'))
    .map(([name, body]) => ({ name, body: String(body) }));
}

function rootScriptIsReachable(
  script: RootScript,
  corpus: string,
  driven: ReadonlyMap<string, string[]>,
): boolean {
  if (new RegExp(`npm run ${escaped(script.name)}(?![\\w:.-])`).test(corpus)) return true;

  for (const match of script.body.matchAll(/run\s+([\w:.-]+)/g)) {
    const delegated = match[1];
    if (
      delegated &&
      delegated !== script.name &&
      new RegExp(`npm run ${escaped(delegated)}(?![\\w:.-])`).test(corpus)
    ) {
      return true;
    }
  }
  for (const match of script.body.matchAll(/--target(?:=|\s+)([\w:.-]+)/g)) {
    const target = match[1];
    if (target && driven.has(target)) return true;
  }
  return false;
}

describe('INVARIANT: test target CI reachability', () => {
  const sources = workflowSources();
  const driven = ciDrivenTargets(sources);
  const declared = declaredTestTargets();

  it('discovers both sides non-vacuously', () => {
    expect(declared.length).toBeGreaterThan(10);
    expect(driven.size).toBeGreaterThan(0);
    expect(declared.some((entry) => entry.target === 'test:integration')).toBe(true);
    expect(declared.some((entry) => entry.target === 'test:invariant')).toBe(true);
  });

  it('makes every non-interactive Nx test target reachable from CI', () => {
    const unreachable = declared
      .filter((entry) => !(entry.target in WATCH_MODE_TARGETS))
      .filter((entry) => !targetIsDirectlyReachable(entry, driven, sources))
      .filter(
        (entry) => !targetDelegatesFromReachableSibling(entry, declared, driven, sources),
      )
      .map((entry) => `${entry.project}:${entry.target}`)
      .sort();

    expect(unreachable).toEqual([]);
  });

  it('does not drive a test-family target absent from every Nx project', () => {
    const declaredNames = new Set(declared.map((entry) => entry.target));
    const dangling = [...driven.entries()]
      .filter(([target]) => target === 'test' || target.startsWith('test:'))
      .filter(([target]) => !declaredNames.has(target))
      .map(([target, files]) => `${target} (${files.join(', ')})`)
      .sort();

    expect(dangling).toEqual([]);
  });

  it('makes every root test entrypoint reachable from CI', () => {
    const scripts = rootTestScripts();
    const corpus = [...sources.values()].join('\n');
    expect(scripts.some((script) => script.name === 'test:schema-invariants')).toBe(true);
    expect(
      scripts
        .filter((script) => !rootScriptIsReachable(script, corpus, driven))
        .map((script) => `${script.name} -> ${script.body}`)
        .sort(),
    ).toEqual([]);
  });

  it('keeps the watch-only exemption exact and live', () => {
    for (const [target, reason] of Object.entries(WATCH_MODE_TARGETS)) {
      const entries = declared.filter((entry) => entry.target === target);
      expect(reason.length).toBeGreaterThan(0);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.command).not.toMatch(/vitest\s+run|--run\b|--ci\b/);
      }
    }
  });
});
