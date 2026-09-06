#!/usr/bin/env ts-node
/**
 * Unit tests for tools/gates/clippy-affected.ts pure
 * helper functions (Batch #348 — closes the test-coverage
 * gap from Batches #346 + #347 where new exported
 * helpers shipped without unit tests).
 *
 * The session's standing memory `feedback_test_after_every_solution.md`
 * mandates "every fix/change must be followed by tests
 * proving fix works". Batch #346 added `affectedLineRanges`
 * and Batch #347 added `parsePrePushStdin` +
 * `rangeForPrePushRef` — all exported but only
 * smoke-tested via live-fire. This file pins their
 * pure-function contracts so a refactor can fail-loud
 * without needing a full git environment.
 *
 * ## Why node:test (not jest)
 *
 * The tools/gates/ tree has no jest infrastructure
 * today — adding it just for a few helper tests is
 * substantial overhead. Node 20.11+ ships `node:test`
 * natively. Invoke via:
 *
 *     ts-node --project tools/gates/tsconfig.json tools/gates/clippy-affected.spec.ts
 *
 * The test runner exits 0 if all asserts pass, non-zero
 * otherwise. CI-grade gate semantics without the jest
 * scaffolding.
 *
 * ## Why the helpers are testable in isolation
 *
 * - `parsePrePushStdin(raw)` — pure string parser; no
 *   git invocation, no FS access. Direct input/output.
 * - `rangeForPrePushRef(ref)` — depends on `git rev-parse`
 *   for the new-branch fallback path; we test both the
 *   pure-input branches (deletion + existing-branch
 *   update) and skip the new-branch case (which would
 *   require a temp git repo).
 * - `affectedLineRanges(base, head, files)` — depends on
 *   `git diff` invocation; we test the pure hunk-parser
 *   logic via a stub-input variant exposed via test-only
 *   re-import. Full integration is verified by the
 *   live-fire tests in Batches #346 + #347.
 *
 * For the helper functions that depend on git command
 * execution, we keep coverage focused on the pure
 * branches — the git-dependent paths are exercised by
 * the live-fire integration tests already documented in
 * the orphan-finding closure notes.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  intersectAffectedLines,
  isPreservationRef,
  parseArgs,
  parseDiffHunkLines,
  parsePrePushStdin,
  rangeForPrePushRef,
  repoRelativeFromClippyPath,
  type PrePushRef,
} from './clippy-affected';

// ---------------------------------------------------------
// intersectAffectedLines (merge-from-main scoping, PROC-MEDIUM-027)
// ---------------------------------------------------------

void test('intersectAffectedLines: keeps only lines new in BOTH ranges', () => {
  const branch = new Map([['sens-api-gateway/src/main.rs', new Set([10, 11, 12, 5905, 5911])]]);
  const sinceMain = new Map([['sens-api-gateway/src/main.rs', new Set([10, 12])]]);
  const result = intersectAffectedLines(branch, sinceMain);
  assert.deepStrictEqual(Array.from(result.keys()), ['sens-api-gateway/src/main.rs']);
  assert.deepStrictEqual(
    Array.from(result.get('sens-api-gateway/src/main.rs') ?? []).sort((a, b) => a - b),
    [10, 12],
  );
});

void test('intersectAffectedLines: a file whose lines all came from main is dropped', () => {
  const branch = new Map([
    ['sens-api-gateway/src/main.rs', new Set([5905, 5911])],
    ['sens-api-gateway/src/db_secret.rs', new Set([40])],
  ]);
  const sinceMain = new Map([['sens-api-gateway/src/db_secret.rs', new Set([40])]]);
  const result = intersectAffectedLines(branch, sinceMain);
  assert.deepStrictEqual(Array.from(result.keys()), ['sens-api-gateway/src/db_secret.rs']);
});

void test('intersectAffectedLines: identical ranges are the identity', () => {
  const lines = new Map([['sens-api-gateway/src/main.rs', new Set([1, 2, 3])]]);
  const result = intersectAffectedLines(lines, new Map(lines));
  assert.deepStrictEqual(Array.from(result.get('sens-api-gateway/src/main.rs') ?? []), [1, 2, 3]);
});

void test('intersectAffectedLines: empty inputs yield an empty map', () => {
  assert.strictEqual(intersectAffectedLines(new Map(), new Map()).size, 0);
  assert.strictEqual(intersectAffectedLines(new Map([['a.rs', new Set([1])]]), new Map()).size, 0);
});

// ---------------------------------------------------------
// isPreservationRef (rescue/ namespace prepush skip)
// ---------------------------------------------------------

void test('isPreservationRef: rescue/ remote refs are preservation pushes', () => {
  assert.strictEqual(
    isPreservationRef('refs/heads/rescue/stash-17-snapshot-20260610'),
    true,
  );
  assert.strictEqual(
    isPreservationRef('refs/heads/rescue/aria-cycle-lab-r4-20260610'),
    true,
  );
});

void test('isPreservationRef: integration-bound refs stay gated', () => {
  assert.strictEqual(isPreservationRef('refs/heads/main'), false);
  assert.strictEqual(isPreservationRef('refs/heads/feature/rescue-ui'), false);
  // The LOCAL side being a rescue checkout must not exempt a push
  // toward a normal remote branch — only the remote destination
  // namespace decides, so a partial name match cannot leak through.
  assert.strictEqual(isPreservationRef('refs/heads/rescued/x'), false);
  assert.strictEqual(isPreservationRef('refs/tags/rescue/x'), false);
});

// ---------------------------------------------------------
// parsePrePushStdin
// ---------------------------------------------------------

void test('parsePrePushStdin: empty input returns empty array', () => {
  assert.deepStrictEqual(parsePrePushStdin(''), []);
  assert.deepStrictEqual(parsePrePushStdin('\n'), []);
  assert.deepStrictEqual(parsePrePushStdin('   \n  \t\n'), []);
});

void test('parsePrePushStdin: single ref parses 4 fields', () => {
  const refs = parsePrePushStdin(
    'refs/heads/main abc123 refs/heads/main def456',
  );
  assert.strictEqual(refs.length, 1);
  assert.deepStrictEqual(refs[0], {
    localRef: 'refs/heads/main',
    localSha: 'abc123',
    remoteRef: 'refs/heads/main',
    remoteSha: 'def456',
  });
});

void test('parsePrePushStdin: multiple refs parsed independently', () => {
  const refs = parsePrePushStdin(
    [
      'refs/heads/main aaa111 refs/heads/main bbb222',
      'refs/heads/feature ccc333 refs/heads/feature ddd444',
    ].join('\n'),
  );
  assert.strictEqual(refs.length, 2);
  assert.strictEqual(refs[0]?.localSha, 'aaa111');
  assert.strictEqual(refs[1]?.localSha, 'ccc333');
});

void test('parsePrePushStdin: malformed lines skipped', () => {
  const refs = parsePrePushStdin(
    [
      'refs/heads/main abc123 refs/heads/main def456', // valid
      'only-three fields here', // 3 parts — skip
      'too many fields a b c d e f', // 6 parts — skip
      '', // empty — skip
      'refs/heads/feature aaa bbb refs/heads/feature ccc', // 5 parts — skip (extra)
      'refs/heads/feature aaa refs/heads/feature bbb', // valid
    ].join('\n'),
  );
  assert.strictEqual(refs.length, 2);
  assert.strictEqual(refs[0]?.localRef, 'refs/heads/main');
  assert.strictEqual(refs[1]?.localRef, 'refs/heads/feature');
});

void test('parsePrePushStdin: tabs + multiple spaces tolerated', () => {
  const refs = parsePrePushStdin(
    'refs/heads/main\tabc123    refs/heads/main\t\tdef456',
  );
  assert.strictEqual(refs.length, 1);
  assert.deepStrictEqual(refs[0], {
    localRef: 'refs/heads/main',
    localSha: 'abc123',
    remoteRef: 'refs/heads/main',
    remoteSha: 'def456',
  });
});

// ---------------------------------------------------------
// rangeForPrePushRef
// ---------------------------------------------------------

void test('rangeForPrePushRef: branch deletion returns null', () => {
  const ref: PrePushRef = {
    localRef: '(delete)',
    localSha: '0000000000000000000000000000000000000000',
    remoteRef: 'refs/heads/old-branch',
    remoteSha: 'aabbccdd',
  };
  assert.strictEqual(rangeForPrePushRef(ref), null);
});

void test('rangeForPrePushRef: 40-zero local SHA detected as deletion', () => {
  // Git always emits 40-char SHAs; pin both the short
  // and full forms via the regex.
  const refShort: PrePushRef = {
    localRef: 'x',
    localSha: '0000000',
    remoteRef: 'y',
    remoteSha: 'aabbccdd',
  };
  assert.strictEqual(rangeForPrePushRef(refShort), null);

  const refFull: PrePushRef = {
    localRef: 'x',
    localSha: '0'.repeat(40),
    remoteRef: 'y',
    remoteSha: 'aabbccdd',
  };
  assert.strictEqual(rangeForPrePushRef(refFull), null);
});

void test('rangeForPrePushRef: existing-branch update returns remote→local range', () => {
  const ref: PrePushRef = {
    localRef: 'refs/heads/main',
    localSha: 'newcommit',
    remoteRef: 'refs/heads/main',
    remoteSha: 'oldcommit',
  };
  const range = rangeForPrePushRef(ref);
  assert.notStrictEqual(range, null);
  assert.strictEqual(range?.base, 'oldcommit');
  assert.strictEqual(range?.head, 'newcommit');
});

void test('rangeForPrePushRef: deletion takes precedence over new-branch check', () => {
  // Pathological case: BOTH localSha and remoteSha are
  // zeros. This shouldn't happen in practice (git emits
  // one or the other but not both for a normal ref) but
  // we pin the precedence: deletion check fires first.
  const ref: PrePushRef = {
    localRef: 'x',
    localSha: '0'.repeat(40),
    remoteRef: 'y',
    remoteSha: '0'.repeat(40),
  };
  assert.strictEqual(rangeForPrePushRef(ref), null);
});

// ---------------------------------------------------------
// parseDiffHunkLines (Batch #350 — extracted hunk parser)
// ---------------------------------------------------------

void test('parseDiffHunkLines: empty input returns empty set', () => {
  assert.strictEqual(parseDiffHunkLines('').size, 0);
  assert.strictEqual(parseDiffHunkLines('\n\n').size, 0);
});

void test('parseDiffHunkLines: single-line addition with default count', () => {
  // `@@ -X +Y @@` (no `,N`) defaults to count=1 per
  // git diff convention.
  const raw = '@@ -10 +20 @@\n+the new line';
  const lines = parseDiffHunkLines(raw);
  assert.strictEqual(lines.size, 1);
  assert.ok(lines.has(20));
});

void test('parseDiffHunkLines: multi-line addition with explicit count', () => {
  // `@@ -10,0 +20,3 @@` adds 3 lines starting at NEW-side line 20.
  const raw = '@@ -10,0 +20,3 @@\n+line 20\n+line 21\n+line 22';
  const lines = parseDiffHunkLines(raw);
  assert.deepStrictEqual(
    Array.from(lines).sort((a, b) => a - b),
    [20, 21, 22],
  );
});

void test('parseDiffHunkLines: pure deletion hunk skipped', () => {
  // `@@ -10,3 +12,0 @@` deletes 3 lines on the OLD side
  // and adds 0 on the NEW side — no new-side lines to
  // gate. Skip.
  const raw = '@@ -10,3 +12,0 @@\n-deleted 1\n-deleted 2\n-deleted 3';
  const lines = parseDiffHunkLines(raw);
  assert.strictEqual(lines.size, 0);
});

void test('parseDiffHunkLines: multiple hunks union into single set', () => {
  const raw = [
    '@@ -1,1 +1,1 @@',
    '+modified line 1',
    '@@ -50,0 +60,2 @@',
    '+added line 60',
    '+added line 61',
    '@@ -100,3 +100,0 @@', // pure deletion, skipped
    '-d',
    '-d',
    '-d',
    '@@ -200 +200 @@',
    '+modified line 200',
  ].join('\n');
  const lines = parseDiffHunkLines(raw);
  assert.deepStrictEqual(
    Array.from(lines).sort((a, b) => a - b),
    [1, 60, 61, 200],
  );
});

void test('parseDiffHunkLines: ignores non-hunk-header lines starting with @@', () => {
  // A diff line that happens to start with `@@` but
  // isn't a hunk header (e.g., a code line containing
  // `@@`) shouldn't false-positive. The regex anchors
  // on the full hunk shape.
  const raw = [
    '@@@ this is not a hunk header @@@',
    '@@-malformed+@@',
    '@@ -10 +20 @@', // valid
  ].join('\n');
  const lines = parseDiffHunkLines(raw);
  // Only the valid header contributes.
  assert.strictEqual(lines.size, 1);
  assert.ok(lines.has(20));
});

void test('parseDiffHunkLines: large new_count yields large range', () => {
  // Pin the range arithmetic for a 100-line addition.
  const raw = '@@ -0,0 +1,100 @@';
  const lines = parseDiffHunkLines(raw);
  assert.strictEqual(lines.size, 100);
  // Boundary checks.
  assert.ok(lines.has(1));
  assert.ok(lines.has(50));
  assert.ok(lines.has(100));
  assert.ok(!lines.has(0));
  assert.ok(!lines.has(101));
});

// ---------------------------------------------------------
// repoRelativeFromClippyPath (Batch #353 — last pure
// function untested before this commit)
// ---------------------------------------------------------

void test('repoRelativeFromClippyPath: prefixes crate-relative paths', () => {
  // cargo clippy emits paths relative to the crate root
  // (e.g., `src/foo.rs`); the gate compares against
  // repo-relative paths (`sens-api-gateway/src/foo.rs`).
  // This helper does the prefix mapping.
  assert.strictEqual(
    repoRelativeFromClippyPath('src/db_migration/manifest.rs'),
    'sens-api-gateway/src/db_migration/manifest.rs',
  );
});

void test('repoRelativeFromClippyPath: returns paths unchanged when already prefixed', () => {
  // Idempotent on already-prefixed paths so a future
  // refactor that emits repo-relative paths from clippy
  // doesn't double-prefix.
  assert.strictEqual(
    repoRelativeFromClippyPath('sens-api-gateway/src/foo.rs'),
    'sens-api-gateway/src/foo.rs',
  );
});

void test('repoRelativeFromClippyPath: handles deep nested paths', () => {
  assert.strictEqual(
    repoRelativeFromClippyPath('src/a/b/c/d/e.rs'),
    'sens-api-gateway/src/a/b/c/d/e.rs',
  );
});

// ---------------------------------------------------------
// parseArgs (Batch #353)
// ---------------------------------------------------------

void test('parseArgs: --mode=range with base + head', () => {
  const opts = parseArgs(['--mode=range', 'origin/main', 'HEAD']);
  assert.strictEqual(opts.mode, 'range');
  assert.strictEqual(opts.base, 'origin/main');
  assert.strictEqual(opts.head, 'HEAD');
});

void test('parseArgs: --mode=range without refs leaves them undefined for main() to validate', () => {
  // parseArgs accepts the mode + leaves base/head
  // undefined; the caller (main) validates that range
  // mode requires both refs. This split keeps parseArgs
  // pure (no process.exit) — tests can exercise the
  // missing-refs case without process termination.
  const opts = parseArgs(['--mode=range']);
  assert.strictEqual(opts.mode, 'range');
  assert.strictEqual(opts.base, undefined);
  assert.strictEqual(opts.head, undefined);
});

void test('parseArgs: --mode=staged returns staged with no refs', () => {
  const opts = parseArgs(['--mode=staged']);
  assert.strictEqual(opts.mode, 'staged');
  assert.strictEqual(opts.base, undefined);
  assert.strictEqual(opts.head, undefined);
});

void test('parseArgs: --mode=prepush returns prepush mode', () => {
  const opts = parseArgs(['--mode=prepush']);
  assert.strictEqual(opts.mode, 'prepush');
});

// ---------------------------------------------------------
// Test-runner footer
// ---------------------------------------------------------

// Node's test runner produces TAP output by default and
// exits non-zero on failure. The shebang + execution via
// ts-node makes this file directly invokable. CI can
// add it to the gate pipeline as:
//
//     ./node_modules/.bin/ts-node --project tools/gates/tsconfig.json tools/gates/clippy-affected.spec.ts
//
// Future expansion: when more helpers gain pure-function
// branches worth pinning (e.g., a future `affectedLineRanges`
// stub-input variant), append tests below this footer.
