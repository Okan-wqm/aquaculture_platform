/**
 * INVARIANT: no tracked JSON file repeats a key inside one object.
 *
 * WHY. `JSON.parse` and Python's `json.loads` keep the LAST of two equal keys
 * and drop the first without a word, so every reader sees a valid object and
 * none of them notices. scripts/ci/affected-target-policy.json carried two
 * `test:integration` blocks for six weeks (f2ab70ef6 re-wired a lane
 * a2ccf0e1e had already wired): the first block's "STRICT" note was never
 * applied, and a quarantine written into it would have been ignored while a
 * reviewer saw it in force (INFRA-MEDIUM-228).
 *
 * WHAT. The CI policy readers refuse a repeated key at run time
 * (scripts/ci/lib/strict-json.mjs). This spec runs the same check over every
 * tracked `*.json` on every PR, which covers the readers that are not routed
 * through it: the kernel's `aria_kernel/data/*.json` policies (read by
 * Python), package.json and project.json files, fixtures. A file `JSON.parse`
 * rejects is skipped, and the skipped set is pinned to NOT_STRICT_JSON: Python's
 * `json.loads` accepts NaN and Infinity, which `JSON.parse` refuses, so a
 * kernel policy carrying one would otherwise leave the scan with every
 * assertion still green.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { removeFixtureTree } from '../../tools/gates/fixture-tree';
import { esmExportResult } from './helpers/esm-export';

const REPO_ROOT = resolve(__dirname, '..', '..');
const STRICT_JSON_LIB = join(REPO_ROOT, 'scripts', 'ci', 'lib', 'strict-json.mjs');

/**
 * The tracked `*.json` files `JSON.parse` rejects, each read only by a tool
 * with its own dialect: JSONC tsconfig files (comments, trailing commas) and
 * an empty Postman placeholder. A file joins this list by a reviewed edit
 * here; any other file that stops being strict JSON fails the scan.
 */
const NOT_STRICT_JSON: readonly string[] = [
  'apps/alert-engine/tsconfig.spec.json',
  'apps/auth-service/tsconfig.spec.json',
  'apps/farm-service/tsconfig.spec.json',
  'docs/api/postman/collection.json',
  'libs/farm-shared/tsconfig.json',
  'libs/migration-harness/tsconfig.spec.json',
  'libs/node-components/tsconfig.json',
  'web/apps/aquamobil/tsconfig.sw.json',
  'web/modules/admin-panel/tsconfig.spec.json',
  'web/shared-ui/tsconfig.json',
  'web/shell/tsconfig.json',
];

interface DuplicateKeyReport {
  readonly checked: number;
  readonly notStrictJson: readonly string[];
  readonly duplicates: readonly string[];
}

function trackedJsonFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', '*.json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((path) => path.length > 0);
}

describe('INVARIANT: tracked JSON has no repeated keys', () => {
  it('finds no object that repeats a key in any tracked JSON file', () => {
    const files = trackedJsonFiles();
    const report = esmExportResult<DuplicateKeyReport>(STRICT_JSON_LIB, 'duplicateKeysInFiles', [
      files.map((path) => join(REPO_ROOT, path)),
    ]);
    // Not vacuous: the scan reached the files it was given.
    expect(report.checked + report.notStrictJson.length).toBe(files.length);
    expect(report.checked).toBeGreaterThan(400);
    expect(report.duplicates).toEqual([]);
    // Only the reviewed files are skipped.
    const skipped = report.notStrictJson.map((path) => path.slice(REPO_ROOT.length + 1)).sort();
    expect(skipped).toEqual([...NOT_STRICT_JSON].sort());
  });

  it('skips a file only Python can read, which the pinned skip set then refuses', () => {
    // {"auto_merge":"refuse","limit":NaN,"auto_merge":"allow"} loads in Python
    // as auto_merge=allow; JSON.parse refuses it, so the scan cannot check it.
    const dir = mkdtempSync(join(tmpdir(), 'json-duplicate-keys-'));
    try {
      const path = join(dir, 'policy.json');
      writeFileSync(path, '{"auto_merge":"refuse","limit":NaN,"auto_merge":"allow"}');
      const report = esmExportResult<DuplicateKeyReport>(STRICT_JSON_LIB, 'duplicateKeysInFiles', [
        [path],
      ]);
      expect(report.checked).toBe(0);
      expect(report.notStrictJson).toEqual([path]);
    } finally {
      removeFixtureTree(dir);
    }
  });

  it('detects a repeated key at any depth and nothing else', () => {
    const paths = (text: string): readonly string[] =>
      esmExportResult<string[]>(STRICT_JSON_LIB, 'duplicateKeyPaths', [text]);
    expect(paths('{"a":1,"b":{"c":[{"d":1,"d":2}]},"a":3}')).toEqual(['$.b.c[0].d', '$.a']);
    // Equal keys in sibling objects, key-like text inside a string value with
    // escaped quotes, and a key that only a nested object also has are not
    // repeats; neither is a key differing only in case.
    expect(paths('{"x":{"k":1},"y":{"k":2},"s":"\\"k\\":1,\\"k\\":2","\\u006b":0,"K":1}')).toEqual(
      [],
    );
    // An escaped spelling of the same key is one: every reader decodes it.
    expect(paths('{"k":1,"\\u006b":2}')).toEqual(['$.k']);
  });
});
