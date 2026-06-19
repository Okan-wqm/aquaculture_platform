#!/usr/bin/env ts-node
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

void test('eslint config imports without ts-node esm deprecation warnings', () => {
  const result = spawnSync(
    process.execPath,
    ['--trace-deprecation', '-e', "import('./eslint.config.mjs')"],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, NX_PREFER_NODE_STRIP_TYPES: 'false' },
    },
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /DEP0180|fs\.Stats|ts-node\/esm|DeprecationWarning/);
});
