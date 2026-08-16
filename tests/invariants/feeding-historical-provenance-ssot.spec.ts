import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
  canonicalJsonStringify,
  createCanonicalJsonDocumentV1,
} from '@aquaculture/shared-contracts';

import {
  FEEDING_HISTORICAL_PROVENANCE_CATALOG_DIGEST_V1,
  FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1,
} from '../../libs/feeding-contracts/src/feeding-historical-provenance.catalog';
import {
  FEEDING_HISTORICAL_PROVENANCE_MIGRATION_SNAPSHOT_DIGEST_V1,
  FEEDING_HISTORICAL_PROVENANCE_MIGRATION_SNAPSHOT_V1,
} from '../../apps/farm-service/src/database/migrations/feeding-historical-provenance-authority.v1';
import {
  FEEDING_HISTORICAL_PROVENANCE_SNAPSHOT_PATH,
  renderFeedingHistoricalProvenanceSnapshotV1,
} from '../../tools/scripts/generate-feeding-historical-provenance';

const ROOT = resolve(__dirname, '..', '..');
const MIGRATION_PATH =
  'apps/farm-service/src/database/migrations/1808900000000-CreateFeedingHistoricalProvenanceAuthority.ts';

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

function typescriptFiles(path: string): readonly string[] {
  const absolute = join(ROOT, path);
  return readdirSync(absolute, { recursive: true, encoding: 'utf8' })
    .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.ts'))
    .map((entry) => join(absolute, entry));
}

function expectRecursivelyFrozen(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const [key, child] of Object.entries(value)) {
    expectRecursivelyFrozen(child, `${path}.${key}`);
  }
}

describe('feeding historical provenance SSOT', () => {
  it('emits one byte-deterministic migration snapshot from the typed catalog', async () => {
    expect(FEEDING_HISTORICAL_PROVENANCE_MIGRATION_SNAPSHOT_V1).toEqual(
      FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1,
    );
    expect(FEEDING_HISTORICAL_PROVENANCE_MIGRATION_SNAPSHOT_DIGEST_V1).toBe(
      FEEDING_HISTORICAL_PROVENANCE_CATALOG_DIGEST_V1,
    );
    expect(read(FEEDING_HISTORICAL_PROVENANCE_SNAPSHOT_PATH)).toBe(
      await renderFeedingHistoricalProvenanceSnapshotV1(),
    );
  });

  it('recursively freezes the catalog and its closed legal predecessor graph', () => {
    const canonicalBefore = canonicalJsonStringify(
      createCanonicalJsonDocumentV1(FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1),
    );
    expectRecursivelyFrozen(FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1);
    const recordGraph = FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1.transitionGraph.subjects.find(
      (candidate) => candidate.subjectKind === 'FEEDING_RECORD',
    );
    if (!recordGraph) throw new Error('Missing FEEDING_RECORD provenance transition authority');
    const resolution = recordGraph.transitions.find(
      (transition) => transition.eventKind === 'ATTRIBUTION_RESOLVED',
    );
    expect(resolution).toEqual({
      predecessorEventKind: 'ATTRIBUTION_QUARANTINED',
      eventKind: 'ATTRIBUTION_RESOLVED',
      predecessorDigestPayloadKey: 'resolvesEventDigest',
      continuityPayloadKeys: ['originalRecordDigest'],
    });
    expect(Reflect.set(resolution as object, 'eventKind', 'ATTRIBUTION_ASSERTED')).toBe(false);
    expect(
      canonicalJsonStringify(
        createCanonicalJsonDocumentV1(FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1),
      ),
    ).toBe(canonicalBefore);
  });

  it('pins the unpublished migration to the generated authority without current-state inference', () => {
    const migration = read(MIGRATION_PATH);
    expect(migration).toContain(
      `const PROVENANCE_CATALOG_DIGEST =\n  '${FEEDING_HISTORICAL_PROVENANCE_CATALOG_DIGEST_V1}'`,
    );
    expect(migration).not.toMatch(/FROM\s+"?feeding_protocols_v2"?/i);
    expect(migration).not.toMatch(/completedAt"?\s*::date/i);
    expect(migration).toContain('locations."movedAt" <= executions."completedAt"');
    expect(migration).toContain('executions."completedAt" < locations."exitedAt"');
    expect(migration).toContain('MULTIPLE_POST_STAMP_CORRECTIONS');
    expect(migration).toContain('UNSTAMPED_HISTORICAL_PLAN');
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('security_invoker = true');
    expect(migration).toContain('feeding provenance tenant does not match app.current_tenant');
    expect(migration).toContain('"eventDigest" <> ${qualified(AUTHORITY.journal.digestFunction)}');
    const idempotencyLock = migration.indexOf("p_tenant_id::text || ':idempotency:'");
    const idempotencyRead = migration.indexOf('SELECT * INTO existing');
    expect(idempotencyLock).toBeGreaterThan(-1);
    expect(idempotencyRead).toBeGreaterThan(idempotencyLock);
    expect(migration).toContain('existing."payloadCanonical" <> payload_canonical');
    expect(migration).toContain('existing."prevDigest" <> p_expected_prev_digest');
    expect(migration).toContain('${legalTransitionPredicate()}');
    expect(migration).toContain('${predecessorDigestMismatchPredicate()}');
    expect(migration).toContain('${continuityMismatchPredicate()}');
    expect(migration).toContain('feeding provenance immutable payload continuity mismatch');
  });

  it('keeps every runtime biomass application adjacent to the single provenance writer', () => {
    const roots = [
      'apps/farm-service/src/feeding',
      'apps/farm-service/src/feeding-protocol/executors',
      'apps/farm-service/src/feeding-protocol/services',
    ];
    const ungoverned: string[] = [];
    for (const file of roots.flatMap(typescriptFiles)) {
      const relativePath = relative(ROOT, file);
      if (relativePath.includes('/__tests__/') || relativePath.endsWith('.spec.ts')) continue;
      if (relativePath.endsWith('biomass-growth-applier.service.ts')) continue;
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\.applyGrowth\s*\(/g)) {
        const tail = source.slice(match.index, match.index + 1_200);
        if (!tail.includes('recordDayPlanGrowthApplication')) {
          ungoverned.push(`${relativePath}:${source.slice(0, match.index).split('\n').length}`);
        }
      }
    }
    expect(ungoverned).toEqual([]);
  });

  it('has no second runtime SQL writer for historical growth counters', () => {
    const runtimeFiles = typescriptFiles('apps/farm-service/src').filter(
      (file) =>
        !relative(ROOT, file).includes('/database/migrations/') &&
        !relative(ROOT, file).includes('/__tests__/') &&
        !relative(ROOT, file).endsWith('.spec.ts'),
    );
    const directWriters = runtimeFiles
      .filter((file) => /SET\s+"rollupAppliedKg"/i.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));
    expect(directWriters).toEqual([]);
  });

  it('excludes quarantined historical attribution from every FCR feed aggregate', () => {
    const fcr = read('apps/farm-service/src/growth/services/fcr-calculation.service.ts');
    expect(fcr.match(/feeding_historical_record_attribution_v1/g)).toHaveLength(2);
    expect(fcr).not.toContain('this.feedingRecordRepository.find({');
    expect(fcr.match(/attribution\.status = 'QUALIFIED'/g)).toHaveLength(2);
  });
});
