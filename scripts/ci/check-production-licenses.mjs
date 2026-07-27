#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const lock = JSON.parse(readFileSync(`${REPO_ROOT}/package-lock.json`, 'utf8'));

const ALLOWED_LICENSE_EXPRESSIONS = new Set([
  '(EDL-1.0 OR EPL-1.0)',
  '(MIT AND BSD-3-Clause)',
  '(MIT AND Zlib)',
  '(MIT OR CC0-1.0)',
  '(MPL-2.0 OR Apache-2.0)',
  '0BSD',
  'Apache-2.0',
  'Apache-2.0 AND LGPL-3.0-or-later',
  'Apache-2.0 AND LGPL-3.0-or-later AND MIT',
  'Apache-2.0 AND MIT',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC-BY-4.0',
  'ISC',
  'LGPL-3.0-or-later',
  'MIT',
  'MIT AND ISC',
  'MIT-0',
  'MPL-2.0',
  'Python-2.0',
  'Unlicense',
]);

/**
 * Restrictive or non-standard licenses are package-and-version scoped.
 * This is a drift control, not a blanket approval of the license family:
 * changing any named version forces a fresh review.
 */
const REVIEWED_EXCEPTIONS = new Map([
  ['@apollo/composition@2.13.3', 'Elastic-2.0'],
  ['@apollo/federation-internals@2.13.3', 'Elastic-2.0'],
  ['@apollo/gateway@2.13.3', 'Elastic-2.0'],
  ['@apollo/query-graphs@2.13.3', 'Elastic-2.0'],
  ['@apollo/query-planner@2.13.3', 'Elastic-2.0'],
  ['@react-leaflet/core@3.0.0', 'Hippocratic-2.1'],
  ['react-leaflet@5.0.0', 'Hippocratic-2.1'],
  // The published metadata contains a typo; the package LICENSE is BSD-3-Clause.
  ['splaytree-ts@1.0.2', 'BDS-3-Clause'],
]);

/**
 * These legacy packages omit the modern `license` field. Their published
 * LICENSE/README or legacy `licenses` metadata identifies the exact license.
 * Exact versions make metadata changes fail closed.
 */
const MISSING_METADATA_EXCEPTIONS = new Map([
  ['arc@0.2.0', 'BSD-2-Clause'],
  ['busboy@1.6.0', 'MIT'],
  ['dequeue@1.0.5', 'BSD-2-Clause'],
  ['humanize@0.0.9', 'MIT'],
  ['passport-strategy@1.0.0', 'MIT'],
  ['pause@0.0.1', 'MIT'],
  ['png-js@1.1.0', 'MIT'],
  ['precond@0.2.3', 'MIT'],
  ['streamsearch@1.1.0', 'MIT'],
  ['xmlhttprequest-ssl@2.1.2', 'MIT'],
]);

function packageName(packagePath) {
  return packagePath.split('node_modules/').at(-1);
}

function isProductionExternalPackage(packagePath, metadata) {
  return (
    packagePath.includes('node_modules/') &&
    metadata.link !== true &&
    metadata.dev !== true &&
    metadata.devOptional !== true
  );
}

const violations = [];
const usedReviewedExceptions = new Set();
const usedMissingMetadataExceptions = new Set();
let checked = 0;

for (const [packagePath, metadata] of Object.entries(lock.packages)) {
  if (!isProductionExternalPackage(packagePath, metadata)) continue;

  checked += 1;
  const identity = `${packageName(packagePath)}@${metadata.version}`;
  const license = metadata.license;

  if (typeof license !== 'string' || license.length === 0) {
    if (MISSING_METADATA_EXCEPTIONS.has(identity)) {
      usedMissingMetadataExceptions.add(identity);
    } else {
      violations.push(`${identity}: missing license metadata`);
    }
    continue;
  }

  if (ALLOWED_LICENSE_EXPRESSIONS.has(license)) continue;

  if (REVIEWED_EXCEPTIONS.get(identity) === license) {
    usedReviewedExceptions.add(identity);
    continue;
  }

  violations.push(`${identity}: unreviewed license ${license}`);
}

for (const identity of REVIEWED_EXCEPTIONS.keys()) {
  if (!usedReviewedExceptions.has(identity)) {
    violations.push(`${identity}: stale reviewed exception`);
  }
}

for (const identity of MISSING_METADATA_EXCEPTIONS.keys()) {
  if (!usedMissingMetadataExceptions.has(identity)) {
    violations.push(`${identity}: stale missing-metadata exception`);
  }
}

if (violations.length > 0) {
  console.error('Production license policy failed:');
  for (const violation of violations.sort()) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  `Production license policy passed: ${checked} locked external packages, ` +
    `${usedReviewedExceptions.size} reviewed exceptions, ` +
    `${usedMissingMetadataExceptions.size} metadata exceptions.`,
);
