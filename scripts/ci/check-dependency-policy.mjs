#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);

const ignoredDirs = new Set([
  '.git',
  '.nx',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'tmp',
]);

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

const exactFiles = new Set([
  '.npmrc',
  'Dockerfile',
  'package.json',
  'package-lock.json',
]);

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

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (ignoredDirs.has(entry)) continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path);
      continue;
    }
    if (stat.isFile() && shouldScan(path)) scanFile(path);
  }
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
  if (/\bplayground\s*:/.test(text) && !rel.startsWith('docs/')) {
    addViolation(path, 'GraphQL Playground configuration is forbidden; use GraphqlRuntimePolicy');
  }
}

function assertPackagePolicy() {
  const packageJsonPath = join(repoRoot, 'package.json');
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const packageLockPath = join(repoRoot, 'package-lock.json');
  const lock = existsSync(packageLockPath)
    ? JSON.parse(readFileSync(packageLockPath, 'utf8'))
    : { packages: {} };
  const allDeps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  };

  if (pkg.dependencies?.['patch-package'] || pkg.devDependencies?.['patch-package']) {
    addViolation(packageJsonPath, 'patch-package dependency is forbidden for supply-chain fixes');
  }

  for (const packageName of [
    '@nestjs/apollo',
    '@apollo/server-plugin-landing-page-graphql-playground',
  ]) {
    if (allDeps[packageName]) {
      addViolation(packageJsonPath, `${packageName} is forbidden; use @platform/graphql-apollo5`);
    }
    if (lock.packages?.[`node_modules/${packageName}`]) {
      addViolation(packageLockPath, `${packageName} must not appear in package-lock.json`);
    }
  }

  for (const [packageName, spec] of Object.entries(allDeps)) {
    if (
      packageName.startsWith('@apollo/') ||
      packageName === '@nestjs/graphql' ||
      packageName === '@as-integrations/express5'
    ) {
      if (typeof spec !== 'string' || /^[~^]/.test(spec)) {
        addViolation(
          packageJsonPath,
          `${packageName} must be exact-pinned for reproducible GraphQL runtime installs`,
        );
      }
    }
    if (
      (packageName === '@nestjs/apollo' || packageName.includes('apollo')) &&
      typeof spec === 'string' &&
      /^(file:|link:|workspace:)/.test(spec)
    ) {
      addViolation(packageJsonPath, `${packageName} must not use a local shadow package`);
    }
  }

  const serializedOverrides = JSON.stringify(pkg.overrides ?? {});
  if (/typeorm[^{}[\]]*uuid|@apollo\/(server|gateway|subgraph)[^{}[\]]*uuid|uuid"\s*:\s*"\^?14/.test(serializedOverrides)) {
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

walk(repoRoot);
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
