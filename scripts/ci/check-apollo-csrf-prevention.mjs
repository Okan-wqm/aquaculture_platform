#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const appRoot = 'apps';
const graphqlModulePattern = /GraphQLModule\.forRoot(?:Async)?\s*</;
const apolloDriverPattern = /Apollo(?:Federation|Gateway)Driver/;
const csrfPattern = /csrfPrevention\s*:\s*true/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') {
        continue;
      }
      yield* walk(path);
      continue;
    }
    if (path.endsWith('.ts')) {
      yield path;
    }
  }
}

const missing = [];
const checked = [];

for (const path of walk(appRoot)) {
  const source = readFileSync(path, 'utf8');
  if (!graphqlModulePattern.test(source) || !apolloDriverPattern.test(source)) {
    continue;
  }

  checked.push(path);
  if (!csrfPattern.test(source)) {
    missing.push(path);
  }
}

if (checked.length === 0) {
  console.error('Apollo CSRF gate found no Apollo GraphQL modules under apps/.');
  process.exit(1);
}

if (missing.length > 0) {
  console.error('Apollo CSRF prevention is missing from these GraphQL modules:');
  for (const path of missing) {
    console.error(`- ${path}`);
  }
  process.exit(1);
}

console.log(`Apollo CSRF prevention gate passed (${checked.length} module(s) checked).`);

