#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from './lib/canonical.mjs';
import { bundleDigest, expectedPaths } from './lib/verify-provenance.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const repositoryRoot = resolve(
  argument('--repo-root', fileURLToPath(new URL('../../../..', import.meta.url))),
);
const planRoot = join(repositoryRoot, 'docs/plans/2026-09-01-new-aria-autonomous-engineering');
const output = join(planRoot, 'verification/verifier-inputs.jsonl');
const records = expectedPaths(planRoot).map((path) => ({
  schema_version: '1.0.0',
  kind: 'input',
  path,
  sha256: sha256File(resolve(planRoot, path)),
}));
const metadata = {
  schema_version: '1.0.0',
  kind: 'metadata',
  verifier_version: '1.0.0',
  claim: 'verifier input provenance; not an admission record',
  recorded_at_utc: new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z'),
  argv: [
    'node',
    'docs/plans/2026-09-01-new-aria-autonomous-engineering/verification/verify-d0.mjs',
    '--repo-root',
    '.',
    '--mode',
    'full',
  ],
  cwd_contract: 'repository root',
  runtime: {
    node_version: process.version,
    node_executable: process.execPath,
    node_executable_sha256: sha256File(process.execPath),
  },
  input_bundle_algorithm: 'sha256(path + NUL + sha256 + LF, lexicographic path order)',
  input_bundle_sha256: bundleDigest(records),
};
const lines = [metadata, ...records].map((record) => JSON.stringify(record)).join('\n');
writeFileSync(output, `${lines}\n`, 'utf8');
process.stdout.write(`WROTE verifier-inputs records=${records.length}\n`);
