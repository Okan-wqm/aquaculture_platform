#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const repoRoot = process.cwd();
const serviceRoot = join(repoRoot, 'apps/messaging-service/src');
const allowedSourceEntities = new Set([
  'apps/messaging-service/src/ai/entities/embeddings-metadata.entity.ts',
  'apps/messaging-service/src/outbox/messaging-outbox.entity.ts',
]);

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walk(fullPath, files);
    } else if (entry.endsWith('.entity.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

const violations = [];
const entityFiles = walk(serviceRoot);
const schemaPinPattern = /@Entity\s*\([\s\S]*?schema\s*:\s*['"]messaging['"][\s\S]*?\)/m;

for (const file of entityFiles) {
  const rel = relative(repoRoot, file);
  if (allowedSourceEntities.has(rel)) continue;

  const source = readFileSync(file, 'utf8');
  if (schemaPinPattern.test(source)) {
    violations.push(rel);
  }
}

if (violations.length > 0) {
  console.error('Messaging tenant entity routing gate failed.');
  console.error('Tenant business entities must not pin schema: messaging.');
  console.error('Allowed source-owned entities:');
  for (const allowed of allowedSourceEntities) {
    console.error(`  - ${allowed}`);
  }
  console.error('Violations:');
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

console.log(
  `Messaging tenant entity routing gate passed (${entityFiles.length} entity file(s) checked).`,
);
