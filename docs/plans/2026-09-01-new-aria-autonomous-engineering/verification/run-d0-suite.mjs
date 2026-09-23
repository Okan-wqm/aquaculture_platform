#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D0_SUITE_POLICY, validateSuiteRoster } from './lib/d0-suite.mjs';

const verificationRoot = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const discovered = readdirSync(verificationRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /^test-.*\.mjs$/u.test(entry.name))
  .map(({ name }) => name)
  .sort();
const suites = validateSuiteRoster(discovered, D0_SUITE_POLICY);

for (const suite of suites) {
  const result = spawnSync(
    process.execPath,
    [join(verificationRoot, suite), ...process.argv.slice(2)],
    {
      cwd: repositoryRoot,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) {
    process.stderr.write(`D0 suite failed: ${suite} status=${String(result.status)}\n`);
    process.exitCode = 1;
    break;
  }
}

if (process.exitCode !== 1) process.stdout.write(`PASS D0 suite roster=${suites.length}\n`);
