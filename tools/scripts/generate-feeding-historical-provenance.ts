#!/usr/bin/env ts-node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  FEEDING_HISTORICAL_PROVENANCE_CATALOG_DIGEST_V1,
  FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1,
} from '../../libs/feeding-contracts/src/feeding-historical-provenance.catalog';

export const FEEDING_HISTORICAL_PROVENANCE_SNAPSHOT_PATH =
  'apps/farm-service/src/database/migrations/feeding-historical-provenance-authority.v1.ts';

export const FEEDING_HISTORICAL_PROVENANCE_CATALOG_PATH =
  'libs/feeding-contracts/src/feeding-historical-provenance.catalog.ts';

export const FEEDING_HISTORICAL_PROVENANCE_GENERATOR_PATH =
  'tools/scripts/generate-feeding-historical-provenance.ts';

function prettyJson(value: unknown): string {
  // eslint-disable-next-line no-restricted-syntax -- committed generated TypeScript artifact.
  return JSON.stringify(value, null, 2);
}

export function renderFeedingHistoricalProvenanceSnapshotV1(): string {
  return `/**
 * GENERATED FILE. DO NOT EDIT.
 * Source: ${FEEDING_HISTORICAL_PROVENANCE_CATALOG_PATH}
 * Generator: ${FEEDING_HISTORICAL_PROVENANCE_GENERATOR_PATH}
 */
// prettier-ignore
export const FEEDING_HISTORICAL_PROVENANCE_MIGRATION_SNAPSHOT_V1 = ${prettyJson(
    FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1,
  )} as const;

export const FEEDING_HISTORICAL_PROVENANCE_MIGRATION_SNAPSHOT_DIGEST_V1 =
  '${FEEDING_HISTORICAL_PROVENANCE_CATALOG_DIGEST_V1}';
`;
}

function main(): void {
  const root = resolve(__dirname, '..', '..');
  const output = resolve(root, FEEDING_HISTORICAL_PROVENANCE_SNAPSHOT_PATH);
  const expected = renderFeedingHistoricalProvenanceSnapshotV1();
  const mode = process.argv[2] ?? '--check';
  if (mode === '--write') {
    writeFileSync(output, expected, 'utf8');
    process.stdout.write(`generated ${FEEDING_HISTORICAL_PROVENANCE_SNAPSHOT_PATH}\n`);
    return;
  }
  if (mode !== '--check') {
    throw new Error(`Unknown mode ${mode}; use --check or --write`);
  }
  const observed = readFileSync(output, 'utf8');
  if (observed !== expected) {
    throw new Error(
      `${FEEDING_HISTORICAL_PROVENANCE_SNAPSHOT_PATH} differs from its catalog; run with --write`,
    );
  }
  process.stdout.write(`verified ${FEEDING_HISTORICAL_PROVENANCE_SNAPSHOT_PATH}\n`);
}

if (require.main === module) {
  main();
}
