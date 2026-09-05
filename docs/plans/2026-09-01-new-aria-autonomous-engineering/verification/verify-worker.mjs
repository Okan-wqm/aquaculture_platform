#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, parseStrictJsonBytes } from './lib/canonical.mjs';
import { verifyVerifiedSnapshot } from './lib/verify.mjs';

const inputPath = process.argv[2];
if (!inputPath) throw new Error('verified worker input path is required');
const input = parseStrictJsonBytes(readFileSync(inputPath), 'verified worker input');
const keys = Object.keys(input ?? {}).sort();
if (
  JSON.stringify(keys) !==
    JSON.stringify(['schema_version', 'source_repository_root', 'target_facts']) ||
  input.schema_version !== '1.0.0'
) {
  throw new Error('verified worker input schema is invalid');
}
const planRoot = fileURLToPath(new URL('..', import.meta.url));
const snapshotRoot = resolve(planRoot, '../../..');
const errors = verifyVerifiedSnapshot(
  { planRoot, repositoryRoot: snapshotRoot },
  input.source_repository_root,
  input.target_facts,
);
process.stdout.write(canonicalJson({ errors }));
