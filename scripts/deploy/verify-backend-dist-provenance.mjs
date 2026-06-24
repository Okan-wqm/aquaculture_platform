#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..', '..');

function usage() {
  console.error('Usage: node scripts/deploy/verify-backend-dist-provenance.mjs <project-csv-or-list>');
  process.exit(2);
}

const rawProjects = process.argv.slice(2).join(',');
if (!rawProjects.trim()) {
  usage();
}

const projects = rawProjects
  .split(',')
  .flatMap((part) => part.split(/\s+/))
  .map((part) => part.trim())
  .filter(Boolean);

function walk(dir) {
  const entries = [];
  if (!existsSync(dir)) {
    return entries;
  }

  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      entries.push(...walk(path));
    } else {
      entries.push(path);
    }
  }

  return entries;
}

const violations = [];

for (const project of projects) {
  const emittedAppRoot = resolve(repoRoot, 'dist', 'apps', project, 'apps', project, 'src');
  const sourceRoot = resolve(repoRoot, 'apps', project, 'src');

  for (const emittedFile of walk(emittedAppRoot)) {
    if (!emittedFile.endsWith('.js')) {
      continue;
    }

    const relative = emittedFile.slice(emittedAppRoot.length + 1);
    const sourceStem = relative.slice(0, -'.js'.length).split(sep).join('/');
    const sourceTs = resolve(sourceRoot, `${sourceStem}.ts`);
    const sourceTsx = resolve(sourceRoot, `${sourceStem}.tsx`);

    if (!existsSync(sourceTs) && !existsSync(sourceTsx)) {
      violations.push(`${project}: ${relative} has no matching source file`);
    }
  }
}

if (violations.length > 0) {
  console.error('Backend dist provenance check failed: stale compiled app files detected.');
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

console.log(`Backend dist provenance OK for ${projects.join(', ')}`);
