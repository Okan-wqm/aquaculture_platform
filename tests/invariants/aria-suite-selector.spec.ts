/**
 * The ARIA pre-push selector (scripts/ci/aria-suite-changed.mjs) and the import graph it
 * selects with (scripts/ci/aria-import-graph.py): what a push runs, in which order, and
 * inside which budget.
 *
 * WHY THIS EXISTS (PROC-MEDIUM-045). The selector picked kernel test modules by the TEXT of a
 * changed module's name and fell back to the whole suite when nothing matched. On the
 * shared host a push touching docs and a few kernel modules ran 4,454 tests in 6,357 s,
 * while the kernel lane in CI runs the same suite sharded anyway. These specs pin the
 * replacement: reachability from the source's import structure, a priority order that puts
 * the push's own tests first, and a wall-clock budget that names what it skipped.
 *
 * The real-tree probes fake `git` (the diff under test), `bash` (the runner) and `npx` (the
 * gate's jest), and run everything else for real: python3 parses the actual kernel, node
 * plans, flock queues on a probe-local lock.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { removeFixtureTree } from '../../tools/gates/fixture-tree';

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const SELECTOR = 'scripts/ci/aria-suite-changed.mjs';
const GRAPH = 'scripts/ci/aria-import-graph.py';
const RUNNER = 'scripts/ci/aria-suite-run.sh';
const LEDGER = 'aria-kernel/aria_kernel/ledger.py';
const DURATIONS = 'aria-suite-durations.json';
// The first real-tree probe parses ~1,200 kernel modules before the cache is warm.
const REAL_TREE_MS = 180_000;

interface Selected {
  path: string;
  tier: number;
  tier_name: string;
  reason: string;
  tests: number;
}

interface Planned {
  path: string;
  tier: number;
  reason: string;
  estimateS: number;
}

interface Plan {
  files: string[];
  budgetS: number;
  gateSpecs: string[];
  selected: Selected[];
  run: Planned[];
  skipped: Planned[];
  estimateS: number;
}

interface GraphOutput {
  selected: Selected[];
  unresolved: unknown[];
  unparsed: string[];
}

interface ProbeOptions {
  args?: string[];
  env?: Record<string, string>;
  durations?: Record<string, number>;
  /** Read the selector's stdout through a pipe nobody drains for a second. */
  slowReader?: boolean;
}

interface ProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** One entry per runner invocation: the arguments `bash` received. */
  bash: string[][];
  npx: string[] | null;
  lockCreated: boolean;
  durations: Record<string, number> | null;
}

// Stands in for .git across the probes: the graph's parse cache and the duration record.
let shared = '';
beforeAll(() => {
  shared = mkdtempSync(join(tmpdir(), 'aria-suite-selector-'));
});
afterAll(() => removeFixtureTree(shared));

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
}

/**
 * A fake that records its argv and does nothing else. The shim lives in `bin/`, its record in
 * `log/`, so no shim can ever write to its own path.
 *
 * WHY THE SPLIT (2026-10-02). The first cut logged `bash` to `$PROBE_DIR/bash` — the shim's own
 * file. The first call appended its argv (`scripts/ci/aria-suite-run.sh …`) to the script, the
 * second call executed those lines, and the runner's `#!/usr/bin/env bash` resolved back to the
 * shim on PATH: an unbounded chain of nested shells that took the shared host to 83,798 tasks.
 */
function writeRecorder(
  bin: string,
  log: string,
  name: string,
  append: boolean,
  envNames: string[] = [],
): void {
  const env = envNames.map((key) => `"${key}=$${key}" `).join('');
  writeExecutable(
    join(bin, name),
    `printf '%s\\n' ${env}"$@" ${append ? '-- >>' : '>'} "${join(log, name)}"`,
  );
}

function probe(
  changed: string[],
  { args = [], env = {}, durations, slowReader = false }: ProbeOptions = {},
): ProbeResult {
  const dir = mkdtempSync(join(tmpdir(), 'aria-suite-selector-probe-'));
  const bin = join(dir, 'bin');
  const log = join(dir, 'log');
  mkdirSync(bin);
  mkdirSync(log);
  const durationsFile = join(shared, DURATIONS);
  rmSync(durationsFile, { force: true });
  if (durations !== undefined) {
    writeFileSync(
      durationsFile,
      JSON.stringify({ schema: 'aria-suite-durations/v1', seconds: durations }),
    );
  }
  try {
    writeFileSync(join(dir, 'changed'), changed.map((path) => `${path}\n`).join(''));
    writeExecutable(
      join(bin, 'git'),
      [
        'case "$1 $2" in',
        '  "rev-parse --abbrev-ref") echo probe-branch; exit 0 ;;',
        '  "rev-parse --verify") exit 0 ;;',
        '  "rev-parse --git-common-dir") echo "$PROBE_SHARED"; exit 0 ;;',
        'esac',
        // `git diff --name-only <range> -- <pathspec>…` lists only the changed paths the
        // pathspec admits, as real git does: the selector's surface list is under test too.
        'if [ "$1" = "diff" ]; then',
        '  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
        '  [ "$#" -gt 0 ] && shift',
        '  while IFS= read -r path; do',
        '    for spec in "$@"; do',
        '      case "$path" in "$spec"|"$spec"/*) printf \'%s\\n\' "$path"; break ;; esac',
        '    done',
        '  done < "$PROBE_DIR/changed"',
        '  exit 0',
        'fi',
        'if [ "$1" = "ls-files" ]; then exec "$PROBE_REAL_GIT" "$@"; fi',
        'exit 2',
      ].join('\n'),
    );
    writeRecorder(bin, log, 'bash', true);
    writeRecorder(bin, log, 'npx', false, ['ARIA_SUITE_GATE_RUN']);
    const [file, argv]: [string, string[]] = slowReader
      ? ['sh', ['-c', '"$PROBE_NODE" "$@" | { sleep 1; cat; }', 'sh', SELECTOR, ...args]]
      : [process.execPath, [SELECTOR, ...args]];
    const result = spawnSync(file, argv, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        PROBE_DIR: dir,
        PROBE_SHARED: shared,
        PROBE_REAL_GIT: REAL_GIT,
        PROBE_NODE: process.execPath,
        ARIA_PREPUSH_LOCK: join(dir, 'lock'),
        ARIA_PREPUSH_BUDGET_S: '',
        ARIA_SUITE_FULL: '',
        // A probe is never inside the gate's own spec run, even when this spec is.
        ARIA_SUITE_GATE_RUN: '',
        ...env,
      },
    });
    const bashLog = join(log, 'bash');
    const npxLog = join(log, 'npx');
    const invocations = existsSync(bashLog)
      ? readFileSync(bashLog, 'utf8')
          .split('--\n')
          .filter((block) => block !== '')
          .map((block) => block.trim().split('\n'))
      : [];
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      bash: invocations,
      npx: existsSync(npxLog) ? readFileSync(npxLog, 'utf8').trim().split('\n') : null,
      lockCreated: existsSync(join(dir, 'lock')),
      durations: existsSync(durationsFile)
        ? (JSON.parse(readFileSync(durationsFile, 'utf8')) as { seconds: Record<string, number> })
            .seconds
        : null,
    };
  } finally {
    removeFixtureTree(dir);
  }
}

function plan(
  changed: string[],
  env: Record<string, string> = {},
  durations?: Record<string, number>,
): Plan {
  const result = probe(changed, { args: ['--plan'], env, durations });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as Plan;
}

/** The selector's priority order: tier, then the cheaper estimate, then the path. */
function priority(a: Planned, b: Planned): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.estimateS !== b.estimateS) return a.estimateS - b.estimateS;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function graph(repo: string, changed: string[], tracked: string[]): GraphOutput {
  const out = execFileSync('python3', [join(REPO_ROOT, GRAPH), '--repo', repo], {
    encoding: 'utf8',
    input: JSON.stringify({ changed, tracked }),
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out) as GraphOutput;
}

const tiers = (selected: Selected[]): Array<[string, string]> =>
  selected.map((entry) => [entry.path.replace('aria-kernel/tests/', ''), entry.tier_name]);

describe('ARIA pre-push import graph on a fixture kernel', () => {
  const FIXTURE: Record<string, string> = {
    'aria-kernel/aria_kernel/__init__.py': [
      'from importlib import import_module',
      '_EXPORT_MODULES = ("store",)',
      'for _name in _EXPORT_MODULES:',
      '    import_module(f"{__name__}.{_name}")',
    ].join('\n'),
    'aria-kernel/aria_kernel/ledger.py': 'def append(row):\n    return row\n',
    'aria-kernel/aria_kernel/store.py':
      'from .ledger import append\n\ndef put(row):\n    return append(row)\n',
    'aria-kernel/aria_kernel/far.py':
      'from aria_kernel.store import put\n\ndef far(row):\n    return put(row)\n',
    'aria-kernel/aria_kernel/policy.py': [
      'from pathlib import Path',
      'POLICY = "policy_table.json"',
      'def load():',
      '    return (Path(__file__).parent / "data" / POLICY).read_text()',
    ].join('\n'),
    'aria-kernel/aria_kernel/data/policy_table.json': '{}\n',
    'aria-kernel/tests/__init__.py': '',
    'aria-kernel/tests/test_ledger.py':
      'from aria_kernel import ledger\n\ndef test_append():\n    assert ledger.append(1)\n',
    // The module's own test family: named for it AND importing it.
    'aria-kernel/tests/invariants/__init__.py': '',
    'aria-kernel/tests/invariants/test_ledger_rotation.py':
      'from aria_kernel.ledger import append\n\ndef test_rot():\n    assert append(6)\n',
    // Named for it, never imports it: the name alone selects nothing.
    'aria-kernel/tests/test_ledger_notes.py':
      'NOTES = "ledger"\n\ndef test_notes():\n    assert NOTES\n',
    'aria-kernel/tests/test_uses_ledger.py':
      'from aria_kernel.ledger import (\n    append,\n)\n\ndef test_a():\n    assert append(2)\n',
    'aria-kernel/tests/test_patches_ledger.py': [
      'from unittest import mock',
      'def test_p():',
      '    with mock.patch("aria_kernel.ledger.append"):',
      '        pass',
    ].join('\n'),
    'aria-kernel/tests/test_store.py':
      'from aria_kernel.store import put\n\ndef test_put():\n    assert put(3)\n',
    'aria-kernel/tests/test_reexport.py':
      'from aria_kernel import put\n\ndef test_r():\n    assert put(4)\n',
    'aria-kernel/tests/test_far.py':
      'from aria_kernel.far import far\n\ndef test_f():\n    assert far(5)\n',
    // The substring defect: every line below spells `ledger`, none imports it.
    'aria-kernel/tests/test_mentions_ledger.py': [
      '# ledger, ledger.py, aria_kernel.ledger',
      'SOURCE = """from aria_kernel.ledger import append"""',
      'def test_m():',
      '    assert "ledger" in SOURCE',
    ].join('\n'),
    'aria-kernel/tests/test_policy.py':
      'from aria_kernel.policy import load\n\ndef test_load():\n    assert load()\n',
    'aria-kernel/tests/test_policy_text.py': [
      'from pathlib import Path',
      'def test_text():',
      '    assert Path("aria-kernel/aria_kernel/data/policy_table.json")',
    ].join('\n'),
    'aria-kernel/tests/test_reads_readme.py':
      'README = "README.md"\n\ndef test_readme():\n    assert README\n',
    // Not importable (no package chain), so not a test module the suite discovers.
    'aria-kernel/tests/fixtures/test_fixture_copy.py': 'from aria_kernel.ledger import append\n',
    'tools/aria-poc/README.md': '# poc\n',
    'docs/README.md': '# docs\n',
  };
  let repo = '';
  const tracked = Object.keys(FIXTURE);

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'aria-import-graph-fixture-'));
    for (const [path, body] of Object.entries(FIXTURE)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), body, 'utf8');
    }
  });
  afterAll(() => removeFixtureTree(repo));

  it('selects importers up to one intermediate module, never a module that only spells the name', () => {
    expect(tiers(graph(repo, ['aria-kernel/aria_kernel/ledger.py'], tracked).selected)).toEqual([
      ['invariants/test_ledger_rotation.py', 'owner'],
      ['test_ledger.py', 'owner'],
      ['test_patches_ledger.py', 'direct'],
      ['test_uses_ledger.py', 'direct'],
      ['test_reexport.py', 'indirect'],
      ['test_store.py', 'indirect'],
    ]);
  });

  it('places a data file through the modules and tests that name it by path', () => {
    const selected = graph(
      repo,
      ['aria-kernel/aria_kernel/data/policy_table.json'],
      tracked,
    ).selected;
    expect(tiers(selected)).toEqual([
      ['test_policy_text.py', 'direct'],
      ['test_policy.py', 'indirect'],
    ]);
  });

  it('selects nothing for a docs-only change, even where a file name is spelled', () => {
    expect(graph(repo, ['docs/README.md', 'tools/aria-poc/README.md'], tracked).selected).toEqual(
      [],
    );
  });

  it('selects a changed test module as itself, first', () => {
    const changed = ['aria-kernel/tests/test_far.py', 'aria-kernel/aria_kernel/ledger.py'];
    expect(tiers(graph(repo, changed, tracked).selected)[0]).toEqual(['test_far.py', 'changed']);
  });
});

describe('ARIA pre-push selector on the real kernel', () => {
  it(
    'leaves no kernel import the graph cannot place',
    () => {
      const out = graph(REPO_ROOT, [], []);
      expect(out.unresolved).toEqual([]);
      expect(out.unparsed).toEqual([]);
    },
    REAL_TREE_MS,
  );

  it(
    'runs the test family of ledger.py first, then its importers, inside the budget',
    () => {
      // ledger.py has no tests/test_ledger.py; its own tests are test_ledger_<aspect>.py.
      // 191 test modules import it directly (2026-10-02), so the run is what the budget
      // buys, never the whole reach: that is CI's job.
      const ledger = plan([LEDGER]);
      const family = ledger.selected
        .filter((entry) => entry.tier_name === 'owner')
        .map((entry) => entry.path)
        .sort();
      expect(family).toEqual(
        expect.arrayContaining([
          'aria-kernel/tests/test_ledger_atomic_append.py',
          'aria-kernel/tests/test_ledger_row_cap.py',
          'aria-kernel/tests/test_ledger_verify_strict.py',
        ]),
      );
      expect(family.every((path) => /\/test_ledger_[^/]*\.py$/.test(path))).toBe(true);
      expect(
        ledger.run
          .slice(0, family.length)
          .map((entry) => entry.path)
          .sort(),
      ).toEqual(family);
      const tierOf = new Map(ledger.selected.map((entry) => [entry.path, entry.tier_name]));
      expect(tierOf.get('aria-kernel/tests/test_pr_tracking_findings_ledger.py')).toBe('direct');
      expect(ledger.selected.some((entry) => entry.tier_name === 'changed')).toBe(false);
      expect(ledger.budgetS).toBe(300);
      expect(ledger.estimateS).toBeLessThanOrEqual(ledger.budgetS);
      expect(ledger.run.length).toBeGreaterThan(family.length);
      expect(ledger.skipped.length).toBeGreaterThan(0);
      expect(ledger.run.length + ledger.skipped.length).toBe(ledger.selected.length);
    },
    REAL_TREE_MS,
  );

  it(
    'selects no kernel test for a docs-only push and runs nothing',
    () => {
      // docs/ is not an ARIA surface (the selector's diff pathspec drops it); the poc README
      // is, and no kernel module imports or names it.
      const docs = ['docs/aria/SPEC.md', 'tools/aria-poc/README.md'];
      const docsPlan = plan(docs);
      expect(docsPlan.files).toEqual(['tools/aria-poc/README.md']);
      expect(docsPlan.selected).toEqual([]);
      const pushed = probe(docs);
      expect(pushed.status).toBe(0);
      expect(pushed.bash).toEqual([]);
      expect(pushed.lockCreated).toBe(false);
    },
    REAL_TREE_MS,
  );

  it(
    'always runs a changed test module first, even when it alone exceeds the budget',
    () => {
      const heavy = 'aria-kernel/tests/test_enterprise_cycle.py';
      const durations = { [heavy]: 900 };
      const planned = plan([LEDGER, heavy], {}, durations);
      expect(planned.run.map((entry) => [entry.path, entry.tier])).toEqual([[heavy, 0]]);
      expect(planned.skipped.length).toBe(planned.selected.length - 1);
      const pushed = probe([LEDGER, heavy], { durations });
      expect(pushed.status).toBe(0);
      expect(pushed.bash).toEqual([[RUNNER, heavy]]);
    },
    REAL_TREE_MS,
  );

  it(
    'orders deterministically and cuts the budget as a prefix of that order',
    () => {
      const changed = [LEDGER, 'aria-kernel/tests/test_ledger_row_cap.py'];
      const first = plan(changed, { ARIA_PREPUSH_BUDGET_S: '60' });
      expect(plan(changed, { ARIA_PREPUSH_BUDGET_S: '60' })).toEqual(first);
      expect(first.run[0]).toMatchObject({
        path: 'aria-kernel/tests/test_ledger_row_cap.py',
        tier: 0,
      });
      const order = [...first.run, ...first.skipped];
      expect(order).toEqual([...order].sort(priority));
      expect(first.skipped.length).toBeGreaterThan(0);
      expect(first.estimateS).toBeLessThanOrEqual(60);
    },
    REAL_TREE_MS,
  );

  it(
    'runs each planned module alone, in plan order, under the host lock, and records its time',
    () => {
      const env = { ARIA_PREPUSH_BUDGET_S: '30' };
      const planned = plan([LEDGER], env);
      const pushed = probe([LEDGER], { env });
      expect(pushed.status).toBe(0);
      expect(pushed.lockCreated).toBe(true);
      expect(pushed.bash).toEqual(planned.run.map((entry) => [RUNNER, entry.path]));
      expect(Object.keys(pushed.durations ?? {}).sort()).toEqual(
        planned.run.map((entry) => entry.path).sort(),
      );
      expect(pushed.stdout).toContain(`skipping ${planned.skipped.length}`);
      expect(pushed.stdout).toContain('.github/workflows/aria-kernel.yml');
    },
    REAL_TREE_MS,
  );

  it(
    'validates its own gate with the specs that pin it, never with the full suite',
    () => {
      const pushed = probe([SELECTOR]);
      expect(pushed.status).toBe(0);
      expect(pushed.npx).toEqual(
        expect.arrayContaining([
          // The jest run is marked, so the selector those specs start cannot start it again.
          'ARIA_SUITE_GATE_RUN=1',
          'jest',
          'tests/invariants/aria-suite-selector.spec.ts',
          'tests/invariants/aria-doc-runtime-ssot.spec.ts',
        ]),
      );
      expect(pushed.bash).toEqual([]);
    },
    REAL_TREE_MS,
  );

  it(
    'never starts its gate run again from inside that run',
    () => {
      const nested = probe([SELECTOR], { env: { ARIA_SUITE_GATE_RUN: '1' } });
      expect(nested.status).toBe(0);
      expect(nested.npx).toBeNull();
      expect(nested.bash).toEqual([]);
      expect(nested.stdout).toContain('already inside its spec run');
    },
    REAL_TREE_MS,
  );

  it(
    'delivers the whole plan through a pipe its reader drains late',
    () => {
      // The ledger plan is larger than a pipe buffer. Exiting with output still queued
      // drops the tail; the reader then parses a cut plan (2026-10-02: 146,176 bytes).
      const reference = plan([LEDGER]);
      const late = probe([LEDGER], { args: ['--plan'], slowReader: true });
      expect(late.stderr).toBe('');
      expect(late.stdout.length).toBeGreaterThan(64 * 1024);
      expect(JSON.parse(late.stdout)).toEqual(reference);
    },
    REAL_TREE_MS,
  );

  it(
    'runs the whole suite once, unbudgeted, under ARIA_SUITE_FULL=1',
    () => {
      const pushed = probe([LEDGER], { env: { ARIA_SUITE_FULL: '1' } });
      expect(pushed.status).toBe(0);
      expect(pushed.bash).toEqual([[RUNNER]]);
    },
    REAL_TREE_MS,
  );
});

describe('ARIA pre-push runner, scoped to one module', () => {
  /**
   * Runs the real runner with a fake `python3` whose unittest and pytest halves exit with the
   * given statuses; returns the runner's status and each collector's argv.
   */
  function scoped(
    paths: string[],
    unittestStatus: number,
    pytestStatus: number,
  ): { status: number | null; calls: string[][] } {
    const dir = mkdtempSync(join(tmpdir(), 'aria-suite-run-scoped-'));
    const bin = join(dir, 'bin');
    const log = join(dir, 'log');
    mkdirSync(bin);
    mkdirSync(log);
    try {
      writeExecutable(
        join(bin, 'python3'),
        [
          // `::end` closes a call: pytest's own argv carries a `--`.
          `printf '%s\\n' "$@" ::end >> "${join(log, 'python3')}"`,
          `case "$2" in unittest) exit ${unittestStatus} ;; pytest) exit ${pytestStatus} ;; esac`,
          'exit 3',
        ].join('\n'),
      );
      const result = spawnSync('bash', [RUNNER, ...paths], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      });
      const record = join(log, 'python3');
      const calls = existsSync(record)
        ? readFileSync(record, 'utf8')
            .split('::end\n')
            .filter((block) => block !== '')
            .map((block) => block.trim().split('\n'))
        : [];
      return { status: result.status, calls };
    } finally {
      removeFixtureTree(dir);
    }
  }

  const NESTED = 'aria-kernel/tests/invariants/v12/test_phase_v12_a_ledger_write_cap.py';

  it('names a nested module by its package for unittest and by its path for pytest', () => {
    const { status, calls } = scoped([NESTED], 0, 0);
    expect(status).toBe(0);
    expect(calls).toEqual([
      ['-m', 'unittest', 'tests.invariants.v12.test_phase_v12_a_ledger_write_cap'],
      ['-m', 'pytest', '-q', '-p', 'aria_kernel.pytest_native_only', '--', NESTED],
    ]);
  });

  it('passes a module only one collector owns, either way round', () => {
    // A module of plain pytest functions: unittest runs nothing (Python 3.12+ exits 5).
    expect(scoped([NESTED], 5, 0).status).toBe(0);
    // A TestCase-only module: the native pytest half collects nothing.
    expect(scoped([NESTED], 0, 5).status).toBe(0);
  });

  it('fails a selection from which neither collector ran a test', () => {
    expect(scoped([NESTED], 5, 5).status).toBe(5);
  });

  it('runs both halves and fails on either half failing', () => {
    const unittestRed = scoped([NESTED], 1, 0);
    expect(unittestRed.status).toBe(1);
    expect(unittestRed.calls).toHaveLength(2);
    expect(scoped([NESTED], 0, 1).status).toBe(1);
  });

  it('refuses a bare file name, which would lose the module its package', () => {
    const bare = scoped(['test_phase_v12_a_ledger_write_cap.py'], 0, 0);
    expect(bare.status).toBe(2);
    expect(bare.calls).toEqual([]);
  });
});
