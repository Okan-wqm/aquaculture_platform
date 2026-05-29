#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const generatedPath = resolve(repoRoot, 'infrastructure/apollo-router/supergraph-config.generated.yaml');

if (!existsSync(generatedPath)) {
  throw new Error(
    'Missing infrastructure/apollo-router/supergraph-config.generated.yaml. Run npm run graphql:generate-registry-artifacts.',
  );
}

process.stdout.write(readFileSync(generatedPath, 'utf8'));
