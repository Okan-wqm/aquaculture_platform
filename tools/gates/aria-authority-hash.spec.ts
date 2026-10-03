#!/usr/bin/env ts-node

/**
 * PROC-HIGH-046 — the ARIA authority surface is derived, never recorded.
 *
 * `docs/aria/CURRENT_STATE.md` used to carry a SHA-256 of every tracked file
 * under the authority roots, rewritten by the pre-commit and post-merge hooks
 * and compared with a fresh digest by the docs SSoT invariant. Every ARIA PR
 * rewrote the same line, so the second of any two ARIA PRs was stale the
 * moment the first merged. These specs pin the replacement contract:
 *
 *   - the authority digest is a pure function of a commit's tree, derived on
 *     demand: same tree, same digest, wherever and whenever it is computed;
 *   - two branches that each change the authority surface merge with no
 *     conflict and no re-stamp, and the merge result is valid as it stands —
 *     including a server-side squash that lands on a later UTC day
 *     (ORPHAN-MEDIUM-792: validity is content, never calendar);
 *   - the guarantee the pin was meant to give, "CURRENT_STATE does not
 *     describe a runtime that has moved", is checked against the tree: a
 *     normative anchor whose path or `file.py::symbol` no longer resolves
 *     fails by name, and so does a recorded digest;
 *   - the `aria-merge-authority` lane keeps checking out the GitHub
 *     merge-result tree and keeps running the docs SSoT gate;
 *   - the CLI `--check` exit code mirrors the pure verdict, and `--write` is
 *     refused because there is nothing to write.
 */

import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import {
  CURRENT_STATE_PATH,
  type CurrentStateDefect,
  ariaAuthorityHash,
  checkCurrentState,
  currentStateAnchors,
} from './aria-authority-hash';
import { removeFixtureTree } from './fixture-tree';

const GATES_ROOT = __dirname;
const SPEC_REPO_ROOT = join(GATES_ROOT, '..', '..');
const MERGE_AUTHORITY_WORKFLOW = join(SPEC_REPO_ROOT, '.github/workflows/aria-merge-authority.yml');

const DAY_D = '2026-08-22T12:00:00Z';
const DAY_D_PLUS_1 = '2026-08-23T12:00:00Z';

/**
 * Hermetic git for fixture repos: no user or system config (so no `merge.*`
 * driver a developer registered can take part in a merge), no auto gc writing
 * under `.git` while the fixture is removed (INFRA-HIGH-172), and none of the
 * GIT_* variables a hook exports (the pre-commit hook runs this spec with
 * GIT_INDEX_FILE pointing at the HOST repository's index).
 */
const HERMETIC_GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_COUNT: '5',
  GIT_CONFIG_KEY_0: 'gc.auto',
  GIT_CONFIG_VALUE_0: '0',
  GIT_CONFIG_KEY_1: 'maintenance.auto',
  GIT_CONFIG_VALUE_1: 'false',
  GIT_CONFIG_KEY_2: 'user.name',
  GIT_CONFIG_VALUE_2: 'Authority Fixture',
  GIT_CONFIG_KEY_3: 'user.email',
  GIT_CONFIG_VALUE_3: 'fixture@example.invalid',
  GIT_CONFIG_KEY_4: 'commit.gpgsign',
  GIT_CONFIG_VALUE_4: 'false',
};

const fixtureRoots: string[] = [];

function gitAt(repoRoot: string, args: readonly string[], when?: string): string {
  const env =
    when === undefined
      ? HERMETIC_GIT_ENV
      : { ...HERMETIC_GIT_ENV, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', env }).trim();
}

function write(repoRoot: string, rel: string, body: string): void {
  mkdirSync(dirname(join(repoRoot, rel)), { recursive: true });
  writeFileSync(join(repoRoot, rel), body, 'utf8');
}

const FIXTURE_CURRENT_STATE = [
  '# ARIA Current State',
  '',
  'Date: 2026-08-22',
  'Target ref: `origin/main`',
  'Status: fixture',
  '',
  '## Current Normative Anchors',
  '',
  '- Ledger primitive: `aria-kernel/aria_kernel/ledger.py`',
  '- Row cap: `aria-kernel/aria_kernel/ledger.py::LEDGER_ROW_MAX_BYTES`',
  '- Executor: `tools/aria-poc/ci_executor.py`',
  '- Habitat drop-ins: `scripts/aria/runner-habitat/systemd/`',
  '',
  '## Clean Trial Rule',
  '',
  // Outside the anchor section: a path the document names as INVALID. It must
  // not be read as a claim that the path exists.
  'Repo-local shadow roots such as `aria-kernel/aria-tools/` are invalid.',
  '',
].join('\n');

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'aria-authority-surface-'));
  fixtureRoots.push(root);
  gitAt(root, ['init', '-q', '-b', 'main']);
  write(root, CURRENT_STATE_PATH, FIXTURE_CURRENT_STATE);
  write(root, 'docs/aria/SPEC.md', '# spec\n\nv1\n');
  write(root, 'aria-kernel/aria_kernel/ledger.py', 'LEDGER_ROW_MAX_BYTES = 65536\n');
  write(root, 'tools/aria-poc/ci_executor.py', 'def main() -> int:\n    return 0\n');
  write(root, 'scripts/aria/runner-habitat/systemd/aria.conf', '[Service]\nMemoryMax=6G\n');
  write(root, '.github/workflows/aria-kernel.yml', 'name: aria-kernel\n');
  write(root, '.github/workflows/ci.yml', 'name: ci\n');
  write(root, 'README.md', '# fixture\n');
  commitAll(root, 'chore: seed authority surface', DAY_D);
  return root;
}

function commitAll(repoRoot: string, message: string, when: string): void {
  gitAt(repoRoot, ['add', '-A']);
  gitAt(repoRoot, ['commit', '-q', '-m', message], when);
}

function defectKinds(repoRoot: string): string[] {
  return checkCurrentState(repoRoot).defects.map((defect: CurrentStateDefect) =>
    defect.kind === 'recorded_authority_digest' || defect.kind === 'normative_anchors_missing'
      ? defect.kind
      : `${defect.kind}:${defect.anchor}`,
  );
}

after(() => {
  for (const root of fixtureRoots) removeFixtureTree(root);
});

void test('the authority digest is a function of the commit tree and nothing else', () => {
  const repo = makeRepo();
  const seed = gitAt(repo, ['rev-parse', 'HEAD']);
  const atSeed = ariaAuthorityHash(repo, seed);
  assert.match(atSeed, /^[a-f0-9]{64}$/);
  // Determinism: the same commit always yields the same digest.
  assert.equal(ariaAuthorityHash(repo, seed), atSeed);

  // The working tree is not an input: an untracked kernel file and an
  // uncommitted edit leave the digest of HEAD where it was.
  write(repo, 'aria-kernel/aria_kernel/scratch.py', 'x = 1\n');
  write(repo, 'docs/aria/SPEC.md', '# spec\n\nuncommitted\n');
  assert.equal(ariaAuthorityHash(repo, 'HEAD'), atSeed);
  gitAt(repo, ['checkout', '-q', '--', 'docs/aria/SPEC.md']);
  gitAt(repo, ['clean', '-q', '-f', '--', 'aria-kernel']);

  // Nor is the checkout's location: a clone of the same commit agrees.
  const clone = mkdtempSync(join(tmpdir(), 'aria-authority-clone-'));
  fixtureRoots.push(clone);
  execFileSync('git', ['clone', '-q', repo, clone], { env: HERMETIC_GIT_ENV });
  assert.equal(ariaAuthorityHash(clone, seed), atSeed);

  // A change outside the authority roots, including a non-aria workflow,
  // does not move it.
  write(repo, 'README.md', '# fixture\n\nmore\n');
  write(repo, '.github/workflows/ci.yml', 'name: ci-renamed\n');
  commitAll(repo, 'docs: non-authority change', DAY_D);
  assert.equal(ariaAuthorityHash(repo, 'HEAD'), atSeed);

  // An authority change moves it, and so does an aria-* workflow change.
  write(repo, 'docs/aria/SPEC.md', '# spec\n\nv2\n');
  commitAll(repo, 'feat: authority change', DAY_D);
  const afterSpec = ariaAuthorityHash(repo, 'HEAD');
  assert.notEqual(afterSpec, atSeed);
  write(repo, '.github/workflows/aria-kernel.yml', 'name: aria-kernel-v2\n');
  commitAll(repo, 'ci: aria workflow change', DAY_D);
  assert.notEqual(ariaAuthorityHash(repo, 'HEAD'), afterSpec);
  // And any earlier commit can still be asked: the value is derived, not kept.
  assert.equal(ariaAuthorityHash(repo, seed), atSeed);
});

void test('two branches that each change the authority surface merge with no conflict and no re-stamp', () => {
  const repo = makeRepo();
  const baseState = readFileSync(join(repo, CURRENT_STATE_PATH), 'utf8');

  gitAt(repo, ['checkout', '-q', '-b', 'feat/kernel']);
  write(repo, 'aria-kernel/aria_kernel/ledger.py', 'LEDGER_ROW_MAX_BYTES = 65536\n# kernel side\n');
  commitAll(repo, 'feat: kernel change', DAY_D);
  assert.equal(checkCurrentState(repo).valid, true);

  gitAt(repo, ['checkout', '-q', '-b', 'feat/executor', 'main']);
  write(repo, 'tools/aria-poc/ci_executor.py', 'def main() -> int:\n    return 1\n');
  write(repo, 'docs/aria/SPEC.md', '# spec\n\nexecutor side\n');
  commitAll(repo, 'feat: executor change', DAY_D);
  assert.equal(checkCurrentState(repo).valid, true);

  // GitHub's merge: no custom driver, plain three-way merge.
  gitAt(repo, ['checkout', '-q', 'main']);
  gitAt(repo, ['merge', '-q', '--no-ff', '--no-edit', 'feat/kernel'], DAY_D);
  gitAt(repo, ['merge', '-q', '--no-ff', '--no-edit', 'feat/executor'], DAY_D_PLUS_1);
  assert.equal(gitAt(repo, ['diff', '--name-only', '--diff-filter=U']), '');

  const verdict = checkCurrentState(repo);
  assert.deepEqual(verdict.defects, []);
  assert.equal(verdict.valid, true);
  // Nothing was re-stamped: the document is byte-identical to the base.
  assert.equal(readFileSync(join(repo, CURRENT_STATE_PATH), 'utf8'), baseState);

  // A server-side squash that lands on the next UTC day is just as valid.
  gitAt(repo, ['checkout', '-q', '-b', 'feat/squash']);
  write(repo, 'docs/aria/SPEC.md', '# spec\n\nsquashed\n');
  commitAll(repo, 'feat: squashed change', DAY_D);
  gitAt(repo, ['checkout', '-q', 'main']);
  gitAt(repo, ['merge', '-q', '--squash', 'feat/squash']);
  gitAt(repo, ['commit', '-q', '-m', 'feat: squashed change (#2)'], DAY_D_PLUS_1);
  assert.equal(checkCurrentState(repo).valid, true);
});

void test('a module rename that leaves a normative anchor dangling fails by name', () => {
  const repo = makeRepo();
  assert.equal(checkCurrentState(repo).valid, true);
  gitAt(repo, ['mv', 'aria-kernel/aria_kernel/ledger.py', 'aria-kernel/aria_kernel/ledger_v2.py']);
  commitAll(repo, 'refactor: rename the ledger module', DAY_D);

  const verdict = checkCurrentState(repo);
  assert.equal(verdict.valid, false);
  assert.deepEqual(defectKinds(repo), [
    'unresolved_path:aria-kernel/aria_kernel/ledger.py',
    'unresolved_symbol:aria-kernel/aria_kernel/ledger.py::LEDGER_ROW_MAX_BYTES',
  ]);
});

void test('a removed owner symbol and a removed anchor directory fail by name', () => {
  const repo = makeRepo();
  write(repo, 'aria-kernel/aria_kernel/ledger.py', 'ROW_LIMIT = 65536\n');
  renameSync(
    join(repo, 'scripts/aria/runner-habitat/systemd'),
    join(repo, 'scripts/aria/runner-habitat/units'),
  );
  commitAll(repo, 'refactor: rename the cap and the drop-in directory', DAY_D);

  assert.deepEqual(defectKinds(repo), [
    'unresolved_path:scripts/aria/runner-habitat/systemd/',
    'unresolved_symbol:aria-kernel/aria_kernel/ledger.py::LEDGER_ROW_MAX_BYTES',
  ]);
});

void test('a digest recorded in CURRENT_STATE is refused', () => {
  const repo = makeRepo();
  const body = readFileSync(join(repo, CURRENT_STATE_PATH), 'utf8').replace(
    'Status: fixture',
    `Last verified ARIA authority hash: \`${'ab'.repeat(32)}\`\nStatus: fixture`,
  );
  write(repo, CURRENT_STATE_PATH, body);
  commitAll(repo, 'docs: record a digest', DAY_D);
  assert.deepEqual(defectKinds(repo), ['recorded_authority_digest']);
});

void test('a CURRENT_STATE without the normative anchor section is refused', () => {
  const repo = makeRepo();
  const body = readFileSync(join(repo, CURRENT_STATE_PATH), 'utf8').replace(
    '## Current Normative Anchors',
    '## Anchors',
  );
  write(repo, CURRENT_STATE_PATH, body);
  commitAll(repo, 'docs: rename the anchor section', DAY_D);
  assert.deepEqual(defectKinds(repo), ['normative_anchors_missing']);
});

void test('anchors come from the normative section; symbols from the whole document', () => {
  const anchors = currentStateAnchors(FIXTURE_CURRENT_STATE);
  assert.deepEqual(
    anchors.paths.map((anchor) => anchor.path),
    [
      'aria-kernel/aria_kernel/ledger.py',
      'aria-kernel/aria_kernel/ledger.py',
      'tools/aria-poc/ci_executor.py',
      'scripts/aria/runner-habitat/systemd/',
    ],
  );
  assert.deepEqual(
    anchors.symbols.map((anchor) => `${anchor.path}::${anchor.symbol}`),
    ['aria-kernel/aria_kernel/ledger.py::LEDGER_ROW_MAX_BYTES'],
  );
  assert.equal(anchors.sectionFound, true);
});

void test('the merge-authority lane checks out the merge-result tree and runs the docs SSoT gate', () => {
  const workflow = readFileSync(MERGE_AUTHORITY_WORKFLOW, 'utf8');
  // `pull_request:` trigger with no checkout `ref:` override means
  // actions/checkout resolves refs/pull/<N>/merge — the GitHub merge-result
  // SHA — not merely the PR head.
  assert.match(workflow, /^on:\s*$/m);
  assert.match(workflow, /^ {2}pull_request:\s*$/m);
  assert.match(workflow, /actions\/checkout@/);
  assert.doesNotMatch(workflow, /github\.event\.pull_request\.head\.sha/);
  assert.match(workflow, /npm run aria:docs:ssot/);
});

void test('the CLI --check exit code mirrors the verdict, and --write is refused', () => {
  const repo = makeRepo();
  const cli = join(GATES_ROOT, 'aria-authority-hash.ts');
  const run = (...args: string[]): SpawnSyncReturns<string> =>
    spawnSync(
      process.execPath,
      [
        require.resolve('ts-node/dist/bin.js'),
        '--project',
        join(GATES_ROOT, 'tsconfig.json'),
        cli,
        ...args,
      ],
      { cwd: repo, encoding: 'utf8', env: HERMETIC_GIT_ENV },
    );

  const valid = run('--check');
  assert.equal(valid.status, 0, `stdout: ${valid.stdout}\nstderr: ${valid.stderr}`);
  assert.match(valid.stdout, /CURRENT_STATE: 3 path anchor\(s\) and 1 symbol anchor\(s\) resolve/);

  const printed = run();
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout.trim(), ariaAuthorityHash(repo, 'HEAD'));

  const refused = run('--write');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /derived/);

  gitAt(repo, ['mv', 'tools/aria-poc/ci_executor.py', 'tools/aria-poc/executor.py']);
  commitAll(repo, 'refactor: rename the executor', DAY_D);
  const stale = run('--check');
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /tools\/aria-poc\/ci_executor\.py/);
});
