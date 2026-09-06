#!/usr/bin/env ts-node
/**
 * Unit tests for tools/gates/banned-construct.ts (Round-2 cluster-0).
 *
 * Pattern: direct import of the pure scanner (require.main guard makes
 * the CLI import-safe — clippy-affected.ts precedent) + node:test
 * runner, no jest scaffolding. The pre-commit hook's
 * `tools/gates/*.spec.ts` glob picks this file up automatically.
 *
 * What this file pins:
 *   - every banned construct fires on a synthetic added line
 *   - constructs hiding in spec-named files STILL fire (the .eslintrc
 *     no-explicit-any spec relaxation is exactly the bypass this gate
 *     closes — regression here would silently reopen it)
 *   - getScopedRepository( does NOT trip the bare-getRepository rule
 *   - per-rule exemption: bare getRepository( inside libs/backend-common
 *     (the scoping SSOT) is allowed
 *   - non-code files (md/json/yml) never fire
 *   - global exemption: the verification fixture path is skipped
 *   - a CODE construct named in a comment does not fire, but a construct that
 *     LIVES in a comment still does
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { scanAddedLines } from './banned-construct';
import type { AddedLine } from './git-diff-ranges';

function line(path: string, text: string, lineNumber = 1): AddedLine {
  return { path, lineNumber, text };
}

void test('each banned construct fires on an added code line', () => {
  const samples: ReadonlyArray<readonly [string, string]> = [
    ['as any', 'const x = payload as any;'],
    ['as unknown as', 'const y = value as unknown as TenantContext;'],
    ['@ts-ignore', '// @ts-ignore -- legacy'],
    ['@ts-expect-error', '// @ts-expect-error wrong overload'],
    ['@ts-nocheck', '// @ts-nocheck'],
    ['test .skip(', "it.skip('flaky spec', () => {});"],
    ['test .skip(', "describe.skip('suite', () => {});"],
    ['xit( / xdescribe( / xtest(', "xit('disabled', () => {});"],
    ['eslint-disable', '/* eslint-disable @typescript-eslint/no-floating-promises */'],
    ['bare getRepository(', 'const repo = dataSource.getRepository(Batch);'],
  ];
  for (const [label, text] of samples) {
    const hits = scanAddedLines([line('apps/farm-service/src/foo.ts', text)]);
    assert.equal(hits.length, 1, `expected exactly one hit for: ${text}`);
    assert.equal(hits[0]?.label, label);
  }
});

void test('spec files are NOT exempt — the eslint spec-relaxation bypass stays closed', () => {
  const hits = scanAddedLines([
    line('apps/farm-service/src/__tests__/batch.spec.ts', 'const mock = repo as any;'),
  ]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.label, 'as any');
});

void test('getScopedRepository( does not trip the bare-getRepository rule', () => {
  const hits = scanAddedLines([
    line('apps/farm-service/src/foo.ts', 'const repo = getScopedRepository(Batch, ctx);'),
  ]);
  assert.equal(hits.length, 0);
});

void test('bare getRepository( is allowed inside the scoping SSOT (libs/backend-common)', () => {
  const hits = scanAddedLines([
    line(
      'libs/backend-common/src/database/scoped-repository.factory.ts',
      'return dataSource.getRepository(entity);',
    ),
  ]);
  assert.equal(hits.length, 0);
});

void test('non-code files never fire', () => {
  const hits = scanAddedLines([
    line('docs/reviews/audit.md', 'the diff added `as any` which is banned'),
    line('package.json', '"as any": "eslint-disable"'),
    line('.github/workflows/ci.yml', '# do not use as any'),
  ]);
  assert.equal(hits.length, 0);
});

void test('verification fixtures are globally exempt', () => {
  const hits = scanAddedLines([
    line('tests/invariants/fixtures/round2/banned-construct-positive.ts', 'const x = y as any;'),
  ]);
  assert.equal(hits.length, 0);
});

void test('clean production line produces no violations', () => {
  const hits = scanAddedLines([
    line(
      'apps/farm-service/src/batches/handlers/create-batch.handler.ts',
      'const repository = getScopedRepository(BatchEntity, tenantContext);',
    ),
  ]);
  assert.equal(hits.length, 0);
});

void test('a code construct named in prose does not fire', () => {
  // A gate that trips on the comment explaining what it forbids forces every
  // docblock to dance around the words that would make it clear.
  const prose: readonly string[] = [
    '// Entity-first EntityManager overloads, not getRepository(Entity).<op>().',
    ' * `as any` is banned; fix the type or write a generic.',
    '/* the old code did `value as unknown as TenantContext` here */',
    '  // it.skip( was how this suite used to hide a real failure',
  ];
  for (const text of prose) {
    assert.deepEqual(
      scanAddedLines([line('apps/billing-service/src/seed.ts', text)]),
      [],
      `prose should not fire: ${text}`,
    );
  }
});

void test('a construct that LIVES in a comment still fires from a comment', () => {
  const inComments: ReadonlyArray<readonly [string, string]> = [
    ['eslint-disable', '// eslint-disable-next-line no-restricted-syntax -- catalogue'],
    ['@ts-ignore', '// @ts-ignore -- legacy'],
    ['@ts-expect-error', ' * @ts-expect-error wrong overload'],
    ['@ts-nocheck', '/* @ts-nocheck */'],
  ];
  for (const [label, text] of inComments) {
    const found = scanAddedLines([line('apps/farm-service/src/x.ts', text)]);
    assert.equal(found.length, 1, `expected ${label} to fire on: ${text}`);
    assert.equal(found[0]?.label, label);
  }
});

void test('a trailing comment does not excuse the code beside it', () => {
  const found = scanAddedLines([
    line('apps/farm-service/src/x.ts', 'const repo = ds.getRepository(Batch); // cross-tenant'),
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.label, 'bare getRepository(');
});
