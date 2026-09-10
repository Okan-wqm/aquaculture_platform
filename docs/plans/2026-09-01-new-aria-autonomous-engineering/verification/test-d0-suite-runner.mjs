#!/usr/bin/env node

import assert from 'node:assert/strict';
import { validateSuiteRoster } from './lib/d0-suite.mjs';

const policy = {
  runnable: ['test-a.mjs', 'test-b.mjs'],
  controllers: ['test-negative-controls.mjs', 'test-target-command.mjs'],
  helpers: ['test-support.mjs'],
};
const discovered = [
  'test-a.mjs',
  'test-b.mjs',
  'test-negative-controls.mjs',
  'test-support.mjs',
  'test-target-command.mjs',
];

assert.deepEqual(validateSuiteRoster(discovered, policy), policy.runnable);
assert.throws(
  () =>
    validateSuiteRoster(
      discovered.filter((path) => path !== 'test-b.mjs'),
      policy,
    ),
  /missing.*test-b/u,
  'a missing required D0 suite was accepted',
);
assert.throws(
  () => validateSuiteRoster([...discovered, 'test-unknown.mjs'], policy),
  /unknown.*test-unknown/u,
  'an unclassified D0 test was silently skipped',
);
assert.throws(
  () =>
    validateSuiteRoster(discovered, {
      ...policy,
      helpers: [...policy.helpers, 'test-a.mjs'],
    }),
  /duplicate.*test-a/u,
  'a runnable suite was also accepted as an exclusion',
);

process.stdout.write('PASS d0-suite-runner closed-roster=required\n');
