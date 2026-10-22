#!/usr/bin/env ts-node
/**
 * tools/gates/event-consumer-index.ts `scanEventProducers` — the one owner of "who produces event
 * T" in code (service-expertise PLAN §2, SE-3), checked on this checkout against an oracle that
 * does not share its method.
 *
 * The scan recognises a producer through the type checker (a call resolving to createBaseEvent in
 * libs/event-contracts) and walks its own file list. The oracle walks `git ls-files` and reads
 * syntax only (a call whose callee is spelled createBaseEvent), so a site the checker misses, an
 * alias the scan follows wrongly, or a source root the walk skips makes the two sets differ.
 *
 * Invoke via:
 *   ts-node --project tools/gates/tsconfig.json tools/gates/event-producer-scan.spec.ts
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

import ts from 'typescript';

import { scanEventProducers } from './event-consumer-index';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** Non-test `.ts` sources under apps/<app>/src, libs/<lib>/src and platform/libs/<lib>/src. */
function trackedSources(): string[] {
  return execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', '-z', '--', 'apps', 'libs', 'platform'],
    {
      encoding: 'utf8',
    },
  )
    .split('\0')
    .filter(
      (path) =>
        /^(?:apps|libs|platform\/libs)\/[^/]+\/src\/.+\.ts$/.test(path) &&
        !/\.(?:spec|test|d)\.ts$/.test(path) &&
        !/(?:^|\/)(?:__tests__|node_modules)\//.test(path),
    );
}

void test('live: the producer scan finds exactly the createBaseEvent calls the parser finds', () => {
  const expected = new Set<string>();
  for (const path of trackedSources()) {
    const text = readFileSync(join(REPO_ROOT, path), 'utf8');
    if (!text.includes('createBaseEvent')) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name
          : node.expression;
        if (ts.isIdentifier(callee) && callee.text === 'createBaseEvent') {
          const line = source.getLineAndCharacterOfPosition(node.expression.getStart(source)).line;
          expected.add(`${path}:${line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const producers = scanEventProducers(REPO_ROOT);
  const scanned = new Set([
    ...producers.entries.map((entry) => entry.site),
    ...producers.unresolved.map((site) => site.site),
    ...producers.unattributed,
  ]);
  assert.ok(expected.size > 100, `the oracle found ${expected.size} calls`);
  assert.deepEqual([...scanned].sort(), [...expected].sort());
});
