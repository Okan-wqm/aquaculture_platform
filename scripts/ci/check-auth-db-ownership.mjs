#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const baselinePath = join(repoRoot, 'scripts/ci/auth-db-ownership-baseline.json');
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const sourceRoots = ['apps', 'libs', 'platform/libs'];
const ignoredSegments = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  '.nx',
  '.codex-worktrees',
]);
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const dmlPattern = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+auth\.(users|refresh_tokens)\b/gi;
const operationMap = {
  'INSERT INTO': 'INSERT',
  UPDATE: 'UPDATE',
  'DELETE FROM': 'DELETE',
};

function walk(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    if (ignoredSegments.has(entry)) continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, files);
    } else if (sourceExtensions.has(path.slice(path.lastIndexOf('.')))) {
      files.push(path);
    }
  }
  return files;
}

function lineFor(source, index) {
  return source.slice(0, index).split('\n').length;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length));
}

function normalizeMatch(match) {
  return {
    operation: operationMap[match[1].toUpperCase()],
    table: `auth.${match[2].toLowerCase()}`,
  };
}

function exemptionKey(item) {
  return `${item.file}|${item.operation}|${item.table}`;
}

const exemptions = new Map();
for (const exemption of baseline.exemptions ?? []) {
  for (const key of ['file', 'operation', 'table', 'maxOccurrences', 'owner', 'removeAfterRelease', 'reason']) {
    if (!exemption[key]) {
      console.error(`Invalid auth DB ownership exemption missing ${key}: ${JSON.stringify(exemption)}`);
      process.exit(1);
    }
  }
  exemptions.set(exemptionKey(exemption), {
    ...exemption,
    count: 0,
  });
}

const violations = [];
for (const root of sourceRoots) {
  for (const file of walk(join(repoRoot, root))) {
    const rel = relative(repoRoot, file).replaceAll('\\', '/');
    if (rel.startsWith('apps/auth-service/')) continue;
    if (rel.includes('/__tests__/') || rel.endsWith('.spec.ts') || rel.endsWith('.test.ts')) continue;

    const source = readFileSync(file, 'utf8');
    const scanSource = stripComments(source);
    for (const match of scanSource.matchAll(dmlPattern)) {
      const normalized = normalizeMatch(match);
      const key = exemptionKey({ file: rel, ...normalized });
      const exemption = exemptions.get(key);
      if (exemption && exemption.count < exemption.maxOccurrences) {
        exemption.count += 1;
        continue;
      }
      violations.push({
        file: rel,
        line: lineFor(source, match.index ?? 0),
        ...normalized,
      });
    }
  }
}

const staleExemptions = [...exemptions.values()].filter((exemption) => exemption.count === 0);
const overBroadExemptions = [...exemptions.values()].filter(
  (exemption) => exemption.count > exemption.maxOccurrences,
);

if (violations.length > 0 || staleExemptions.length > 0 || overBroadExemptions.length > 0) {
  console.error('Auth DB ownership gate failed.');
  for (const violation of violations) {
    console.error(
      `  - ${violation.file}:${violation.line} performs ${violation.operation} ${violation.table} outside apps/auth-service`,
    );
  }
  for (const exemption of staleExemptions) {
    console.error(
      `  - stale exemption can be removed: ${exemption.file} ${exemption.operation} ${exemption.table}`,
    );
  }
  for (const exemption of overBroadExemptions) {
    console.error(
      `  - exemption exceeded maxOccurrences=${exemption.maxOccurrences}: ${exemption.file} ${exemption.operation} ${exemption.table}`,
    );
  }
  process.exit(1);
}

console.log('Auth DB ownership gate passed.');
