#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProjectionSet } from './lib/projections.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const repositoryRoot = resolve(
  argument('--repo-root', fileURLToPath(new URL('../../../..', import.meta.url))),
);
const planRoot = join(repositoryRoot, 'docs/plans/2026-09-01-new-aria-autonomous-engineering');
const check = process.argv.includes('--check');
const outputs = buildProjectionSet(planRoot, repositoryRoot);
const drift = [];

for (const [relativePath, expected] of outputs) {
  const path = join(planRoot, relativePath);
  if (check) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== expected) drift.push(relativePath);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, expected);
  }
}

if (drift.length > 0) {
  process.stderr.write(`Projection drift:\n${drift.map((path) => `- ${path}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${check ? 'PASS' : 'WROTE'} projections=${outputs.size}\n`);
}
