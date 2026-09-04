/**
 * INVARIANT: test-family Nx targets and their CI invocations must agree, in
 * BOTH directions.
 *
 * ## Why this exists
 *
 * Two live defects of the same shape were found on 2026-07-27, and neither was
 * visible to any existing gate because both failure modes are silently GREEN:
 *
 *   1. `farm-service:test:integration` was declared and invoked by NOTHING.
 *      Thirteen suites — Testcontainers tenant-isolation, the schema-routing
 *      architecture invariant that apps/farm-service/CLAUDE.md names as its
 *      owner, and a 202-line P0 security gate — had never run. They rotted
 *      quietly: a spec stopped compiling one wave and nobody noticed for
 *      several more (FARM-MEDIUM-301).
 *
 *   2. `.github/workflows/ci-affected.yml` drove `--target test:invariant`,
 *      which NO project declared. `affected-target-policy.sh` receives an empty
 *      project list, prints "No strict … projects remain" and exits 0 — so the
 *      step passed forever while the service-worker invariant it names never
 *      executed.
 *
 * Direction 1 (declared but never run) hides rot. Direction 2 (driven but not
 * declared) fakes coverage. Both are tier-3 detectable and neither is
 * detectable any other way: nothing in Nx, jest or the shell scripts errors on
 * an empty selection, because an empty selection is legitimate on most PRs.
 *
 * A third instance of the same shape was found on 2026-07-29, and it was
 * invisible to BOTH directions above because both read the Nx project graph:
 *
 *   3. `libs/backend-common`, `libs/storage`, `platform/libs/event-bus` and
 *      `platform/libs/outbox` each shipped a working `jest.config.*` and NO
 *      `project.json`. With no project there is no target, so `nx affected -t
 *      test` could never select them, `getJestProjectsAsync()` (the root
 *      aggregate config) skipped them, and no workflow named their config in a
 *      `run:` step. 127 spec files had therefore never executed in CI —
 *      including the tenant-RLS install helper, the tenant-context middleware
 *      and the MODULE_SCHEMAS fan-out pin. They had rotted exactly as
 *      FARM-MEDIUM-301 predicted: the RLS suite no longer reached the code it
 *      tested, the fan-out pin was 8 tables stale, the subdomain suite asserted
 *      a fail-OPEN behaviour production had since closed, and
 *      `rls.module.spec.ts` asserted a boot guard the code had stopped
 *      implementing.
 *
 * ## What is checked
 *
 * Every project target whose name is `test` or starts with `test:` must be
 * reachable from CI; every target name CI drives through the affected-target
 * policy script must exist on at least one project; and every jest config in
 * the repository must be owned by a project whose test target is itself
 * reachable — a config nothing can select is a suite nothing runs.
 *
 * Watch-mode targets are exempt by name: their body is an interactive `vitest`
 * with no `run`, so invoking one in CI would hang the job forever. The exemption
 * is asserted, not assumed — an entry that stops looking like a watch script
 * fails, so the list cannot quietly become a dumping ground.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

/**
 * Targets that must never be driven by CI. Keyed by target name; the value is
 * the reason, and the spec verifies each named target really is a watch script.
 */
const WATCH_MODE_TARGETS: Readonly<Record<string, string>> = {
  'test:watch': 'interactive vitest watch — invoking it in CI hangs the job',
};

/**
 * Targets with NO CI runner that are nonetheless accepted, each with the reason
 * it is not a coverage gap. Anything not listed here must be reachable, so a
 * newly added test target forces a deliberate choice: wire it, or justify it.
 *
 * Keyed `<project>:<target>` so an exemption cannot silently widen to another
 * project that happens to reuse the script name.
 */
const UNREACHABLE_ALLOWLIST: Readonly<Record<string, string>> = {
  // Empty on purpose. It held `shared-ui:test:coverage` and `shell:test:coverage`
  // — coverage-reporting variants of gated `test` targets — and both projects have
  // since stopped declaring them. The self-expiry check below is what noticed:
  // an exemption for a target that no longer exists is a claim about a gate that
  // is not there, which is the same defect class the invariant exists to catch.
};

/**
 * Root-`package.json` `test:*` scripts with no CI runner that are nonetheless
 * accepted. Same contract as UNREACHABLE_ALLOWLIST: absent from this map, a
 * script must be invoked by some workflow.
 */
const UNREACHABLE_ROOT_SCRIPTS: Readonly<Record<string, string>> = {};

interface ProjectTarget {
  readonly project: string;
  readonly target: string;
  readonly command: string;
}

/**
 * Every `test`/`test:*` target, read from the Nx project graph.
 *
 * The graph is the authoritative view on purpose. Parsing project.json and
 * package.json directly over-collects: a package.json `scripts` entry is not
 * automatically an Nx target (e2e/package.json declares `test:integration` and
 * `test:invariants` that Nx does not expose), so a hand-rolled scan reports
 * unreachable targets CI could never have run and pushes the reader toward
 * exempting phantoms. What matters here is what `nx affected -t <name>` can
 * actually select.
 */
function declaredTestTargets(): ProjectTarget[] {
  const graphFile = join(tmpdir(), `nx-graph-test-reachability-${process.pid}.json`);
  execFileSync('npx', ['nx', 'graph', `--file=${graphFile}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: 'ignore',
    env: { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' },
  });

  const parsed: unknown = JSON.parse(readFileSync(graphFile, 'utf8'));
  rmSync(graphFile, { force: true });

  const nodes =
    typeof parsed === 'object' && parsed !== null
      ? (Reflect.get(Reflect.get(parsed, 'graph') ?? {}, 'nodes') as unknown)
      : undefined;
  if (typeof nodes !== 'object' || nodes === null) return [];

  const out: ProjectTarget[] = [];
  for (const [project, node] of Object.entries(nodes)) {
    const targets = Reflect.get(Reflect.get(node, 'data') ?? {}, 'targets') as unknown;
    if (typeof targets !== 'object' || targets === null) continue;
    for (const [target, body] of Object.entries(targets)) {
      if (target !== 'test' && !target.startsWith('test:')) continue;
      out.push({ project, target, command: JSON.stringify(body) });
    }
  }
  return out;
}

/** Target names CI drives through the affected-target policy script. */
function ciDrivenTargets(): Map<string, string[]> {
  const byTarget = new Map<string, string[]>();
  for (const entry of readdirSync(WORKFLOW_DIR)) {
    if (!entry.endsWith('.yml') && !entry.endsWith('.yaml')) continue;
    const source = readFileSync(join(WORKFLOW_DIR, entry), 'utf8');
    for (const match of source.matchAll(
      /affected-target-policy\.sh\s+--target\s+([\w:.-]+)/g,
    )) {
      const target = match[1];
      if (!target) continue;
      byTarget.set(target, [...(byTarget.get(target) ?? []), entry]);
    }
  }
  return byTarget;
}

/**
 * A target counts as reachable if CI drives it by name through the policy
 * script, or invokes it directly (`nx run <p>:<t>`, `nx <t> <p>`, or an
 * `npm --workspace … run <t>` for a package.json script).
 */
function isReachableFromCi(entry: ProjectTarget, driven: Map<string, string[]>): boolean {
  if (driven.has(entry.target)) return true;

  const needles = [
    `nx run ${entry.project}:${entry.target}`,
    `nx ${entry.target} ${entry.project}`,
    `run ${entry.target}`,
  ];
  for (const file of readdirSync(WORKFLOW_DIR)) {
    if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
    const source = readFileSync(join(WORKFLOW_DIR, file), 'utf8');
    if (needles.some((needle) => source.includes(needle))) return true;
  }
  return false;
}

/**
 * A target is also covered when a REACHABLE sibling in the same project invokes
 * it — `test: "npm run test:run"` means gating `test` gates `test:run` too.
 * Detected mechanically rather than allowlisted, so the delegation cannot drift
 * out from under the exemption.
 */
function isDelegatedFromReachableSibling(
  entry: ProjectTarget,
  declared: readonly ProjectTarget[],
  driven: Map<string, string[]>,
): boolean {
  return declared.some(
    (sibling) =>
      sibling.project === entry.project &&
      sibling.target !== entry.target &&
      sibling.command.includes(entry.target) &&
      isReachableFromCi(sibling, driven),
  );
}

/**
 * Root-`package.json` scripts named `test` / `test:*`.
 *
 * The Nx-graph scan above deliberately ignores package.json `scripts` blocks,
 * because a workspace-package script is not automatically an Nx target and
 * scanning them over-collects phantoms. The ROOT package.json is the one
 * exception: its `test:*` entries ARE the documented developer + CI
 * entrypoints (CLAUDE.md's Commands section calls them by name), and CI invokes
 * several of them literally as `npm run <name>`. So they are a real entrypoint
 * class the graph cannot see — and one that had a live hole:
 * `test:schema-invariants` ran the physical schema-layout gate that
 * `apps/farm-service/CLAUDE.md` names as an enforcement mechanism, while
 * `db-migration-check.yml` listed the spec only under `paths:` and never in a
 * `run:` step (FARM-MEDIUM-303). Triggering a workflow is not running a test.
 */
function rootTestScripts(): Array<{ name: string; body: string }> {
  const pkg: unknown = JSON.parse(
    readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
  );
  const scripts = Reflect.get(pkg as object, 'scripts');
  if (typeof scripts !== 'object' || scripts === null) return [];
  return Object.entries(scripts)
    .filter(([name]) => name === 'test' || name.startsWith('test:'))
    .map(([name, body]) => ({ name, body: String(body) }));
}

/** Text of every workflow file, concatenated once. */
function workflowCorpus(): string {
  return readdirSync(WORKFLOW_DIR)
    .filter((entry) => entry.endsWith('.yml') || entry.endsWith('.yaml'))
    .map((entry) => readFileSync(join(WORKFLOW_DIR, entry), 'utf8'))
    .join('\n');
}

/**
 * A root script counts as run when a workflow invokes it by name, when its body
 * delegates to something a workflow invokes (`test:e2e:mobile` →
 * `npm --prefix e2e run test:mobile`, which e2e-tests.yml runs), or when it is
 * a thin wrapper over an Nx target CI already drives by name.
 *
 * The delegation legs are mechanical rather than allowlisted so a script that
 * stops delegating loses its exemption automatically.
 */
function isRootScriptRun(
  script: { name: string; body: string },
  corpus: string,
  driven: Map<string, string[]>,
): boolean {
  // `npm run <name>` — not matching a longer sibling (`test:e2e` vs `test:e2e:mobile`).
  const invoked = new RegExp(
    `npm run ${script.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w:.-])`,
  );
  if (invoked.test(corpus)) return true;

  // Delegation: `npm --prefix <dir> run <inner>` where CI runs `<inner>`.
  for (const match of script.body.matchAll(/run\s+([\w:.-]+)/g)) {
    const inner = match[1];
    if (!inner || inner === script.name) continue;
    const innerInvoked = new RegExp(
      `npm run ${inner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w:.-])`,
    );
    if (innerInvoked.test(corpus)) return true;
  }

  // Wrapper over an Nx target CI drives through the affected-target policy.
  for (const match of script.body.matchAll(/--target[= ]([\w:.-]+)/g)) {
    const target = match[1];
    if (target && driven.has(target)) return true;
  }
  return false;
}

/**
 * Every `jest.config.*` in the repo, workspace-relative, from git's index so
 * build output and node_modules cannot pad or hide the list.
 */
function jestConfigFiles(): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '*jest.config.*'], {
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // The root aggregate config owns no suite of its own — it fans out to the
    // per-project configs via getJestProjectsAsync().
    .filter((line) => line !== 'jest.config.js');
}

/**
 * Jest configs deliberately not owned by an Nx test target, each with the
 * reason. Absent from this map, a config must be reachable — so adding a jest
 * config forces a deliberate choice: wire it, or say why not.
 */
const UNOWNED_JEST_CONFIGS: Readonly<Record<string, string>> = {
  'tests/e2e/v11-compat/jest.config.ts':
    'NestJS v11 upgrade compatibility lane, invoked by path from the upgrade workflow — not part of the affected-target policy.',
  'tests/e2e/v11-upgrade/jest.config.ts':
    'NestJS v11 upgrade lane, same rationale as v11-compat above.',
  'e2e/jest.config.ts':
    'Driven by the root `test:tenant-clone` / `test:schema-invariants` scripts and nats-invariants.yml, all by path; the root-script direction gates those.',
};

describe('INVARIANT: test-target CI reachability', () => {
  const declared = declaredTestTargets();
  const driven = ciDrivenTargets();

  it('finds the workspace targets at all (the scan cannot silently return nothing)', () => {
    expect(declared.length).toBeGreaterThan(10);
    expect(driven.size).toBeGreaterThan(0);
    // The two targets this invariant was written for.
    expect(declared.some((d) => d.target === 'test:integration')).toBe(true);
    expect(declared.some((d) => d.target === 'test:invariant')).toBe(true);
  });

  it('runs every declared test target somewhere in CI', () => {
    const unreachable = declared
      .filter((entry) => !(entry.target in WATCH_MODE_TARGETS))
      .filter((entry) => !(`${entry.project}:${entry.target}` in UNREACHABLE_ALLOWLIST))
      .filter((entry) => !isReachableFromCi(entry, driven))
      .filter((entry) => !isDelegatedFromReachableSibling(entry, declared, driven))
      .map((entry) => `${entry.project}:${entry.target}`);

    expect(unreachable).toEqual([]);
  });

  it('drives no test-family CI target that does not exist on any project', () => {
    const declaredNames = new Set(declared.map((entry) => entry.target));
    const dangling = [...driven.entries()]
      // Scoped to the test family: this invariant owns test targets, and `lint`
      // is legitimately driven through the same policy script.
      .filter(([target]) => target === 'test' || target.startsWith('test:'))
      .filter(([target]) => !declaredNames.has(target))
      .map(([target, files]) => `${target} (driven by ${files.join(', ')})`);

    expect(dangling).toEqual([]);
  });

  it('keeps the unreachable allowlist honest — no entry that has since been wired or deleted', () => {
    const live = new Set(declared.map((entry) => `${entry.project}:${entry.target}`));
    const stale = Object.keys(UNREACHABLE_ALLOWLIST).filter((key) => {
      if (!live.has(key)) return true; // deleted target — exemption is dead weight
      const [project, ...rest] = key.split(':');
      const target = rest.join(':');
      const entry = declared.find((d) => d.project === project && d.target === target);
      return entry ? isReachableFromCi(entry, driven) : true; // now wired — drop it
    });

    expect(stale).toEqual([]);
  });

  it('runs every root-package.json test script somewhere in CI', () => {
    const corpus = workflowCorpus();
    const scripts = rootTestScripts();

    // A broken read must not fake a pass.
    expect(scripts.length).toBeGreaterThan(3);
    expect(scripts.some((s) => s.name === 'test:schema-invariants')).toBe(true);

    const unrun = scripts
      .filter((script) => !(script.name in UNREACHABLE_ROOT_SCRIPTS))
      .filter((script) => !isRootScriptRun(script, corpus, driven))
      .map((script) => `${script.name} → ${script.body}`);

    expect(unrun).toEqual([]);
  });

  it('keeps the root-script allowlist honest — no entry that has since been wired or deleted', () => {
    const corpus = workflowCorpus();
    const scripts = rootTestScripts();
    const stale = Object.keys(UNREACHABLE_ROOT_SCRIPTS).filter((name) => {
      const script = scripts.find((s) => s.name === name);
      if (!script) return true; // deleted script — exemption is dead weight
      return isRootScriptRun(script, corpus, driven); // now wired — drop it
    });

    expect(stale).toEqual([]);
  });

  it('owns every jest config with a CI-reachable test target', () => {
    const configs = jestConfigFiles();
    // A broken `git ls-files` must not fake a pass.
    expect(configs.length).toBeGreaterThan(10);

    const corpus = workflowCorpus();
    const orphans = configs
      .filter((config) => !(config in UNOWNED_JEST_CONFIGS))
      .filter((config) => {
        // Owned when some CI-reachable test target names this config path.
        const owner = declared.find(
          (entry) => entry.command.includes(config) && isReachableFromCi(entry, driven),
        );
        if (owner) return false;
        // Or when a workflow invokes it by path directly.
        return !corpus.includes(config);
      });

    expect(orphans).toEqual([]);
  });

  it('keeps the unowned-config allowlist honest — no entry that has since been wired or deleted', () => {
    const configs = new Set(jestConfigFiles());
    const stale = Object.keys(UNOWNED_JEST_CONFIGS).filter((config) => {
      if (!configs.has(config)) return true; // deleted config — exemption is dead weight
      return declared.some(
        (entry) => entry.command.includes(config) && isReachableFromCi(entry, driven),
      );
    });

    expect(stale).toEqual([]);
  });

  it('keeps the watch-mode exemption honest — every entry really is a watch script', () => {
    for (const [target, reason] of Object.entries(WATCH_MODE_TARGETS)) {
      const entries = declared.filter((entry) => entry.target === target);
      expect(reason.length).toBeGreaterThan(0);
      // If nothing declares it any more, the exemption is stale and must go.
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        // A watch script runs `vitest`/`jest` WITHOUT a run/CI flag. Anything
        // else is a real target hiding behind the exemption.
        expect(entry.command).not.toMatch(/vitest\s+run|--run\b|--ci\b/);
      }
    }
  });
});
