#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const repoRoot = process.cwd();
const failures = [];

function read(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function walk(dir, files = []) {
  for (const entry of readdirSync(join(repoRoot, dir))) {
    const rel = join(dir, entry);
    if (rel.includes('node_modules') || rel.includes('/dist/') || rel.includes('/coverage/')) {
      continue;
    }
    const abs = join(repoRoot, rel);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      walk(rel, files);
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
      files.push(rel);
    }
  }
  return files;
}

function fail(message) {
  failures.push(message);
}

const settingsPage = read('web/shell/src/pages/SettingsPage.tsx');
const settingsOperations = read('web/shell/src/graphql/settings.operations.ts');

if (/(?:query|mutation)\s+[A-Z][A-Za-z0-9_]*\s*(?:\(|\{)/.test(settingsPage)) {
  fail('SettingsPage.tsx must not define inline GraphQL operations; use web/shell/src/graphql/settings.operations.ts.');
}

if (/updateProfile\s*\(/.test(settingsPage) || /changePassword\s*\(/.test(settingsPage)) {
  fail('SettingsPage.tsx must use updateMyProfile/changeMyPassword, not deprecated account aliases.');
}

for (const required of [
  'mutation UpdateMyProfile($input: UpdateMyProfileInput!)',
  'updateMyProfile(input: $input)',
  'mutation ChangeMyPassword($input: ChangeMyPasswordInput!)',
  'changeMyPassword(input: $input)',
  'query MySecuritySettings',
]) {
  if (!settingsOperations.includes(required)) {
    fail(`settings.operations.ts is missing canonical operation fragment: ${required}`);
  }
}

for (const deprecated of ['mutation UpdateProfile', 'updateProfile(input:', 'mutation ChangePassword', 'changePassword(input:']) {
  if (settingsOperations.includes(deprecated)) {
    fail(`settings.operations.ts must not use deprecated operation: ${deprecated}`);
  }
}

const storageFiles = [
  'web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx',
  'web/apps/aquamobil/src/pages/storage/StockTransferPage.tsx',
];
for (const file of storageFiles) {
  const source = read(file);
  if (/StorageItemFilterInput|storageItems\s*\(/.test(source)) {
    fail(`${file} still references removed StorageItemFilterInput/storageItems GraphQL contract.`);
  }
}

const rawGraphqlFiles = [];
for (const file of walk('web')) {
  const normalized = relative(repoRoot, join(repoRoot, file));
  if (normalized.includes('/src/graphql/')) {
    continue;
  }
  const source = read(normalized);
  if (/(?:gql\s*`|graphql\s*`|(?:query|mutation)\s+[A-Z][A-Za-z0-9_]*\s*(?:\(|\{))/.test(source)) {
    rawGraphqlFiles.push(normalized);
  }
}

if (process.env.GRAPHQL_RAW_STRING_GATE === 'error' && rawGraphqlFiles.length > 0) {
  fail(`Raw GraphQL operations remain outside src/graphql operation modules: ${rawGraphqlFiles.join(', ')}`);
}

if (failures.length > 0) {
  console.error('GraphQL contract drift gate failed:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

if (rawGraphqlFiles.length > 0) {
  console.log('GraphQL contract drift gate passed with report-only raw GraphQL findings:');
  for (const file of rawGraphqlFiles) {
    console.log(`  - ${file}`);
  }
} else {
  console.log('GraphQL contract drift gate passed. No raw GraphQL findings outside operation modules.');
}
