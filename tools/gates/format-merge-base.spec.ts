/**
 * format-merge-base.spec.ts — pins the comparison rule `format check-staged`
 * uses to tell inherited Prettier debt from a regression.
 *
 * WHY this exists: the pre-commit gate judged staged files against HEAD
 * alone. Inside a merge commit a file that first appears from the other
 * branch has no HEAD blob, so the gate read every Prettier-dirty file that
 * branch already carried as the merge's own regression and forced a reformat
 * of the other branch's files inside the merge — a whitespace diff that
 * conflicted with the next thing that branch landed. PR #1582 hit that
 * treadmill four merges in a row while another lane kept landing dirty files.
 *
 * The rule under test is pure (git and Prettier are injected), so every branch
 * of it is pinned here without a repository. The module is ESM; the gate specs
 * run under ts-node's CommonJS loader, so it is exercised through a child
 * `node` process the way alertmanager-render.spec.ts exercises its script.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

const REPO_ROOT = resolve(__dirname, '..', '..');
const MODULE = resolve(REPO_ROOT, 'tools/quality/format-merge-base.mjs');

interface Scenario {
  hasHead: boolean;
  hasMergeHead: boolean;
  /** Blob content by `git show` spec; absent key = no blob. */
  blobs: Record<string, string>;
  /** Sources Prettier would call clean. */
  clean: string[];
}

function baseFor(scenario: Scenario): string | null {
  const script = `
    import { mergeAwareBaseSource } from ${JSON.stringify(MODULE)};
    const s = ${JSON.stringify(scenario)};
    const clean = new Set(s.clean);
    const out = mergeAwareBaseSource('src/x.ts', {
      hasHead: s.hasHead,
      hasMergeHead: s.hasMergeHead,
      isClean: (source) => clean.has(source),
      readBlob: (spec) => (spec in s.blobs ? s.blobs[spec] : null),
    });
    process.stdout.write(JSON.stringify(out));
  `;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return JSON.parse(stdout) as string | null;
}

const HEAD_DIRTY = 'head-dirty';
const HEAD_CLEAN = 'head-clean';
const OTHER_DIRTY = 'other-dirty';
const OTHER_CLEAN = 'other-clean';

test('outside a merge the base is HEAD, dirty or clean', () => {
  assert.equal(
    baseFor({
      hasHead: true,
      hasMergeHead: false,
      blobs: { 'HEAD:src/x.ts': HEAD_DIRTY },
      clean: [],
    }),
    HEAD_DIRTY,
  );
  assert.equal(
    baseFor({
      hasHead: true,
      hasMergeHead: false,
      blobs: { 'HEAD:src/x.ts': HEAD_CLEAN },
      clean: [HEAD_CLEAN],
    }),
    HEAD_CLEAN,
  );
});

test('outside a merge a file new at HEAD has no base (regression)', () => {
  assert.equal(baseFor({ hasHead: true, hasMergeHead: false, blobs: {}, clean: [] }), null);
});

test('a repository without HEAD has no base even mid-merge', () => {
  assert.equal(
    baseFor({
      hasHead: false,
      hasMergeHead: true,
      blobs: { 'MERGE_HEAD:src/x.ts': OTHER_DIRTY },
      clean: [],
    }),
    null,
  );
});

test('in a merge, a file the other branch already carried dirty is inherited debt', () => {
  assert.equal(
    baseFor({
      hasHead: true,
      hasMergeHead: true,
      blobs: { 'MERGE_HEAD:src/x.ts': OTHER_DIRTY },
      clean: [],
    }),
    OTHER_DIRTY,
  );
});

test('in a merge, HEAD dirty wins without consulting the other parent', () => {
  assert.equal(
    baseFor({
      hasHead: true,
      hasMergeHead: true,
      blobs: { 'HEAD:src/x.ts': HEAD_DIRTY, 'MERGE_HEAD:src/x.ts': OTHER_CLEAN },
      clean: [OTHER_CLEAN],
    }),
    HEAD_DIRTY,
  );
});

test('in a merge, HEAD clean but the other parent dirty is inherited debt', () => {
  assert.equal(
    baseFor({
      hasHead: true,
      hasMergeHead: true,
      blobs: { 'HEAD:src/x.ts': HEAD_CLEAN, 'MERGE_HEAD:src/x.ts': OTHER_DIRTY },
      clean: [HEAD_CLEAN],
    }),
    OTHER_DIRTY,
  );
});

test("in a merge, clean at both parents falls back to HEAD (drift is the merge's own)", () => {
  assert.equal(
    baseFor({
      hasHead: true,
      hasMergeHead: true,
      blobs: { 'HEAD:src/x.ts': HEAD_CLEAN, 'MERGE_HEAD:src/x.ts': OTHER_CLEAN },
      clean: [HEAD_CLEAN, OTHER_CLEAN],
    }),
    HEAD_CLEAN,
  );
});

test('in a merge, a file new at both parents has no base (regression)', () => {
  assert.equal(baseFor({ hasHead: true, hasMergeHead: true, blobs: {}, clean: [] }), null);
});
