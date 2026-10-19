#!/usr/bin/env ts-node
/**
 * fixture-tree — ARIA-LOW-595.
 *
 * A script-style test (a file run whole by ts-node, as `nx test aria-adapters`
 * runs each `tools/aria-adapters/*.test.ts`) builds its workspace at module
 * level, where there is no `afterAll` to remove it. Eleven adapter tests called
 * `mkdtempSync` and never removed the tree: one run of the target left 20
 * directories in the temp dir. `makeFixtureTree` is the owner's creation half:
 * the tree it makes is removed, through `removeFixtureTree`, when the process
 * exits — normally, by `process.exit`, or on an uncaught failure.
 *
 * Each case runs the real module in a child process whose temp dir is a
 * scratch directory, so "removed at exit" is observed from outside the process
 * that exited.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import { removeFixtureTree } from './fixture-tree';

const REPO_ROOT = resolve(__dirname, '..', '..');
const OWNER = join(REPO_ROOT, 'tools/gates/fixture-tree');
const scratchRoots: string[] = [];

after(() => {
  for (const root of scratchRoots) {
    removeFixtureTree(root);
  }
});

type ChildRun = { status: number | null; stdout: string; stderr: string; scratch: string };

/** Run `body` in a child node with the owner bound to `makeFixtureTree` and TMPDIR = a fresh scratch dir. */
function runChild(body: string): ChildRun {
  const scratch = mkdtempSync(join(tmpdir(), 'fixture-tree-spec-'));
  scratchRoots.push(scratch);
  const program = [
    `const { makeFixtureTree } = require(${JSON.stringify(OWNER)});`,
    "const { existsSync, mkdirSync, writeFileSync } = require('node:fs');",
    body,
  ].join('\n');
  const run = spawnSync(process.execPath, ['-r', 'ts-node/register', '-e', program], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      TMPDIR: scratch,
      TS_NODE_PROJECT: join(REPO_ROOT, 'tools/gates/tsconfig.json'),
      TS_NODE_TRANSPILE_ONLY: 'true',
    },
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, scratch };
}

/**
 * What the child's fixtures left in its temp dir. The toolchain writes its own
 * cache there too (ts-node's `v8-compile-cache-<uid>`), which is not a fixture,
 * so the count is of the trees this spec's prefix names.
 */
function fixtureResidue(scratch: string): string[] {
  return readdirSync(scratch).filter((name) => name.startsWith('fixture-tree-'));
}

/** The trees the child reported making, each with whether it existed while the child ran. */
function madeTrees(stdout: string): Array<{ path: string; existedWhileRunning: boolean }> {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith('TREES '));
  assert.ok(line, `the child reported no trees:\n${stdout}`);
  return JSON.parse(line.slice('TREES '.length)) as Array<{
    path: string;
    existedWhileRunning: boolean;
  }>;
}

const MAKE_TWO_TREES = [
  "const a = makeFixtureTree('fixture-tree-a-');",
  "const b = makeFixtureTree('fixture-tree-b-');",
  "writeFileSync(a + '/file', 'x');",
  "mkdirSync(b + '/nested/deeper', { recursive: true });",
  "writeFileSync(b + '/nested/deeper/file', 'x');",
  'process.stdout.write("TREES " + JSON.stringify([a, b].map((path) => ({ path, existedWhileRunning: existsSync(path) }))) + "\\n");',
].join('\n');

for (const [ending, statement, expectedStatus] of [
  ['the process ends normally', '', 0],
  ['the process calls process.exit', 'process.exit(3);', 3],
  ['the process dies on an uncaught failure', "throw new Error('a failed assertion');", 1],
] as const) {
  void test(`a tree made by makeFixtureTree is removed when ${ending}`, () => {
    const run = runChild(`${MAKE_TWO_TREES}\n${statement}`);

    assert.equal(run.status, expectedStatus, run.stderr);
    const trees = madeTrees(run.stdout);
    assert.equal(trees.length, 2);
    for (const tree of trees) {
      assert.ok(tree.path.startsWith(run.scratch), `${tree.path} is not under the temp dir`);
      assert.equal(tree.existedWhileRunning, true, `${tree.path} did not exist while the test ran`);
      assert.equal(existsSync(tree.path), false, `${tree.path} survived the process`);
    }
    assert.deepEqual(fixtureResidue(run.scratch), [], 'no fixture tree is left in the temp dir');
  });
}

void test('many trees share one exit hook, so no listener-leak warning is printed', () => {
  const run = runChild(
    [
      'const trees = [];',
      "for (let index = 0; index < 25; index += 1) trees.push(makeFixtureTree('fixture-tree-many-'));",
      'process.stdout.write("TREES " + JSON.stringify(trees.map((path) => ({ path, existedWhileRunning: existsSync(path) }))) + "\\n");',
    ].join('\n'),
  );

  assert.equal(run.status, 0, run.stderr);
  assert.equal(madeTrees(run.stdout).length, 25);
  assert.doesNotMatch(run.stderr, /MaxListenersExceededWarning/);
  assert.deepEqual(fixtureResidue(run.scratch), []);
});
