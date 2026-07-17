#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);

const scannedExtensions = new Set([
  '.dockerfile',
  '.hcl',
  '.js',
  '.json',
  '.mjs',
  '.sh',
  '.ts',
  '.yaml',
  '.yml',
]);

const exactFiles = new Set(['.npmrc', 'Dockerfile', 'package.json', 'package-lock.json']);

const policyViolations = [];
const textOnlyHistoricalFiles = new Set([
  'scripts/ci/check-dependency-policy.mjs',
  'tools/scripts/seed-finding-registry.mjs',
]);

function fileExtension(path) {
  const basename = path.split('/').pop() ?? path;
  if (basename.toLowerCase().startsWith('dockerfile')) return '.dockerfile';
  const dot = basename.lastIndexOf('.');
  return dot === -1 ? '' : basename.slice(dot);
}

function shouldScan(path) {
  const rel = relative(repoRoot, path).replaceAll('\\', '/');
  const basename = rel.split('/').pop() ?? rel;
  return exactFiles.has(basename) || scannedExtensions.has(fileExtension(rel));
}

function repositorySourceFiles() {
  let output;
  try {
    output = execFileSync(
      'git',
      ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`dependency policy could not enumerate repository source files: ${reason}`);
  }

  return output
    .split('\0')
    .filter(Boolean)
    .map((path) => join(repoRoot, path));
}

function addViolation(path, reason) {
  policyViolations.push(`${relative(repoRoot, path).replaceAll('\\', '/')}: ${reason}`);
}

function scanFile(path) {
  const rel = relative(repoRoot, path).replaceAll('\\', '/');
  if (textOnlyHistoricalFiles.has(rel)) return;

  const text = readFileSync(path, 'utf8');

  if (/\bnpm\s+ci\b[^\n]*--legacy-peer-deps\b/.test(text)) {
    addViolation(path, 'npm ci must not use --legacy-peer-deps');
  }
  if (/\bnpm\s+install\b[^\n]*--legacy-peer-deps\b/.test(text)) {
    addViolation(path, 'npm install must not use --legacy-peer-deps');
  }
  if (/\bnpm\s+(ci|install|update|audit\s+fix)\b[^\n]*\s--force\b/.test(text)) {
    addViolation(path, 'npm dependency commands must not use --force');
  }
  if (/\bpatch-package\b/.test(text) && !rel.startsWith('docs/')) {
    addViolation(path, 'patch-package is not an approved dependency remediation path');
  }
}

function assertPackagePolicy() {
  const packageJsonPath = join(repoRoot, 'package.json');
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

  if (pkg.dependencies?.['patch-package'] || pkg.devDependencies?.['patch-package']) {
    addViolation(packageJsonPath, 'patch-package dependency is forbidden for supply-chain fixes');
  }

  const serializedOverrides = JSON.stringify(pkg.overrides ?? {});
  if (
    /typeorm[^{}[\]]*uuid|@apollo\/(server|gateway|subgraph)[^{}[\]]*uuid|uuid"\s*:\s*"\^?14/.test(
      serializedOverrides,
    )
  ) {
    addViolation(
      packageJsonPath,
      'uuid overrides for TypeORM/Apollo or global uuid@14 overrides are forbidden',
    );
  }
}

function assertNpmPolicy() {
  const npmrcPath = join(repoRoot, '.npmrc');
  if (!existsSync(npmrcPath)) {
    addViolation(npmrcPath, '.npmrc must exist and enforce strict-peer-deps=true');
    return;
  }
  const npmrc = readFileSync(npmrcPath, 'utf8');
  if (!/^strict-peer-deps=true$/m.test(npmrc)) {
    addViolation(npmrcPath, '.npmrc must contain strict-peer-deps=true');
  }
}

for (const path of repositorySourceFiles()) {
  if (shouldScan(path)) scanFile(path);
}
assertPackagePolicy();
assertNpmPolicy();

if (policyViolations.length > 0) {
  console.error('Dependency policy violations detected:');
  for (const violation of policyViolations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

console.log('Dependency policy gate passed.');
