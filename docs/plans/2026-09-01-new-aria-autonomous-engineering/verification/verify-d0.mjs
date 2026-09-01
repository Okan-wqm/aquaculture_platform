#!/usr/bin/env node

import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyD0 } from './lib/verify.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const repositoryRoot = resolve(
  argument('--repo-root', fileURLToPath(new URL('../../../..', import.meta.url))),
);
const mode = argument('--mode', 'full');
const planRoot = join(repositoryRoot, 'docs/plans/2026-09-01-new-aria-autonomous-engineering');

if (mode !== 'full') {
  process.stderr.write(`Unsupported mode: ${mode}\n`);
  process.exitCode = 2;
} else {
  const errors = verifyD0(planRoot, { repositoryRoot });
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`${error.code}: ${error.message}\n`);
    process.stderr.write(`FAIL errors=${errors.length}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `PASS D0 verifier node=${process.version} findings=88 sprints=72 gates=9 events=5 state=VERIFYING\n`,
    );
  }
}
