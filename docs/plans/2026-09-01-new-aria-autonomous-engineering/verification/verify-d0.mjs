#!/usr/bin/env node

import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyD0Bootstrap } from './lib/bootstrap-d0.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const repositoryRoot = resolve(
  argument('--repo-root', fileURLToPath(new URL('../../../..', import.meta.url))),
);
const mode = argument('--mode', 'full');
const declaredTarget = {
  baseSha: argument('--base'),
  headSha: argument('--head'),
  reviewedRef: argument('--reviewed-ref'),
  baseTree: argument('--base-tree'),
  headTree: argument('--head-tree'),
  diffSha256: argument('--diff-sha256'),
  designSha256: argument('--design-sha256'),
  formatScopeSha256: argument('--format-scope-sha256'),
};
const planRoot = join(repositoryRoot, 'docs/plans/2026-09-01-new-aria-autonomous-engineering');
const declaredValues = Object.values(declaredTarget);
const hasDeclaredTarget = declaredValues.some((value) => value !== undefined);
const target = hasDeclaredTarget ? declaredTarget : undefined;

if (mode !== 'full' || (hasDeclaredTarget && declaredValues.some((value) => value === undefined))) {
  process.stderr.write(
    'Usage: verify-d0.mjs --repo-root <root> --mode full [complete exact target arguments]\n',
  );
  process.exitCode = 2;
} else {
  const { errors, targetFacts } = verifyD0Bootstrap(planRoot, { repositoryRoot, target });
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`${error.code}: ${error.message}\n`);
    process.stderr.write(`FAIL errors=${errors.length}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`TARGET_FACTS ${JSON.stringify(targetFacts)}\n`);
    process.stdout.write(
      `PASS D0 verifier node=${process.version} findings=88 sprints=72 gates=9 events=6 state=VERIFYING\n`,
    );
  }
}
