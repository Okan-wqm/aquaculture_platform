#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { buildApiContract } from './lib/api-contract.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const repositoryRoot = resolve(
  argument('--repo-root', fileURLToPath(new URL('../../../..', import.meta.url))),
);
const planRoot = join(repositoryRoot, 'docs/plans/2026-09-01-new-aria-autonomous-engineering');
const output = join(planRoot, 'verification/generated-api-contract.json');
const prettierConfig = await resolveConfig(output);
if (!prettierConfig) throw new Error('repository Prettier configuration is required');
const expected = await format(JSON.stringify(buildApiContract(planRoot)), {
  ...prettierConfig,
  filepath: output,
});
const check = process.argv.includes('--check');

if (check) {
  if (!existsSync(output) || readFileSync(output, 'utf8') !== expected) {
    process.stderr.write('FAIL generated API contract drift\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('PASS generated-api-contract terminal=7Q/9M S06=7Q/0M\n');
  }
} else {
  writeFileSync(output, expected, 'utf8');
  process.stdout.write('WROTE generated-api-contract terminal=7Q/9M S06=7Q/0M\n');
}
