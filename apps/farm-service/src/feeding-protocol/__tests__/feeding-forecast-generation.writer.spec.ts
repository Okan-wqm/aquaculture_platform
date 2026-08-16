import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import {
  FEEDING_FORECAST_GENERATION_AUTHORITY,
  FEEDING_FORECAST_GENERATION_CATALOG_DIGEST,
  compileFeedingForecastMortalityProvenanceV1,
  compileFeedingForecastGenerationExactSetProofV1,
} from '@aquaculture/feeding-contracts';
import { createMockDataSource } from '@aquaculture/testing';

import {
  createFarmDurableMutationTestComposition,
  type FarmDurableMutationTestComposition,
} from '../../__tests__/support/durable-mutation-test-authority';
import type { ForecastProjectionGenerationIntentV1 } from '../feeding-aggregate-mutation.writer';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const OLD_GENERATION = '33333333-3333-4333-8333-333333333333';
const NEW_GENERATION = '44444444-4444-4444-8444-444444444444';
const OPERATION = 'forecast-refresh:2026-08-09T07:00:00.000Z';
const SOURCE_WATERMARK = new Date('2026-08-09T07:00:00.000Z');
const EMPTY_MORTALITY_PROVENANCE = compileFeedingForecastMortalityProvenanceV1([]);

function forecastIntent(): ForecastProjectionGenerationIntentV1 {
  return {
    operationId: OPERATION,
    sourceWatermark: SOURCE_WATERMARK,
    snapshots: [
      {
        siteScopeKey: SITE,
        poolScope: 'SITE',
        horizonDays: 30,
        computedAt: SOURCE_WATERMARK,
        perFeed: [],
        perUnit: [],
        alerts: [],
        mortalityAssumption: EMPTY_MORTALITY_PROVENANCE,
      },
      {
        siteScopeKey: 'tenant',
        poolScope: 'TENANT',
        horizonDays: 30,
        computedAt: SOURCE_WATERMARK,
        perFeed: [],
        perUnit: [],
        alerts: [],
        mortalityAssumption: EMPTY_MORTALITY_PROVENANCE,
      },
    ],
  };
}

describe('FeedingAggregateMutationPort forecast generation authority', () => {
  let composition: FarmDurableMutationTestComposition;

  beforeAll(async () => {
    composition = await createFarmDurableMutationTestComposition();
  });

  afterAll(async () => {
    await composition.close();
  });

  it('writes, qualifies and CAS-activates one immutable exact-set generation', async () => {
    const intent = forecastIntent();
    const proof = compileFeedingForecastGenerationExactSetProofV1(
      intent.snapshots.map((snapshot) => ({
        siteScopeKey: snapshot.siteScopeKey,
        poolScope: snapshot.poolScope,
        payload: snapshot,
      })),
    );
    const { mockDataSource, mockManager, mockQueryRunner } = createMockDataSource();
    mockManager.query.mockImplementation((sql: string) => {
      if (sql.includes(`FROM "${FEEDING_FORECAST_GENERATION_AUTHORITY.activePointer.relation}"`)) {
        return Promise.resolve([{ generationId: OLD_GENERATION }]);
      }
      if (sql.includes('SELECT COUNT(*)::int AS count')) return Promise.resolve([{ count: 3 }]);
      if (
        sql.includes(`INSERT INTO "${FEEDING_FORECAST_GENERATION_AUTHORITY.generationRelation}"`)
      ) {
        return Promise.resolve([{ id: NEW_GENERATION }]);
      }
      return Promise.resolve([]);
    });

    const result = await runInTenantTransaction(
      mockDataSource,
      'farm',
      TENANT,
      (_queryRunner, session) =>
        composition.feedingMutations.reconcileForecastProjection(session, intent),
    );

    expect(result).toEqual({
      generationId: NEW_GENERATION,
      exactSetDigest: proof.exactSetDigest,
      writtenCount: 2,
      retiredSnapshotCount: 3,
      replayed: false,
    });
    expect(mockManager.query).toHaveBeenCalledWith(
      expect.stringContaining(
        `INSERT INTO "${FEEDING_FORECAST_GENERATION_AUTHORITY.generationRelation}"`,
      ),
      [
        TENANT,
        OPERATION,
        FEEDING_FORECAST_GENERATION_AUTHORITY.schemaVersion,
        FEEDING_FORECAST_GENERATION_CATALOG_DIGEST,
        SOURCE_WATERMARK,
        proof.exactSetDigest,
        proof.membershipDigest,
        2,
        OLD_GENERATION,
      ],
    );
    expect(mockManager.query).toHaveBeenCalledWith(
      expect.stringContaining(FEEDING_FORECAST_GENERATION_AUTHORITY.mutationFunctions.qualify),
      [TENANT, NEW_GENERATION, proof.exactSetDigest, proof.membershipDigest, 2, SOURCE_WATERMARK],
    );
    expect(mockManager.query).toHaveBeenCalledWith(
      expect.stringContaining(FEEDING_FORECAST_GENERATION_AUTHORITY.mutationFunctions.activate),
      [TENANT, NEW_GENERATION, OLD_GENERATION, SOURCE_WATERMARK],
    );
    const statements = mockManager.query.mock.calls.map(([sql]) => String(sql));
    const generationInsert = statements.findIndex((sql) =>
      sql.includes(`INSERT INTO "${FEEDING_FORECAST_GENERATION_AUTHORITY.generationRelation}"`),
    );
    const snapshotInserts = statements
      .map((sql, index) => ({ index, sql }))
      .filter(({ sql }) =>
        sql.includes(`INSERT INTO "${FEEDING_FORECAST_GENERATION_AUTHORITY.snapshotRelation}"`),
      );
    const qualification = statements.findIndex((sql) =>
      sql.includes(FEEDING_FORECAST_GENERATION_AUTHORITY.mutationFunctions.qualify),
    );
    const activation = statements.findIndex((sql) =>
      sql.includes(FEEDING_FORECAST_GENERATION_AUTHORITY.mutationFunctions.activate),
    );
    expect(snapshotInserts).toHaveLength(2);
    expect(snapshotInserts.every(({ index }) => index > generationInsert)).toBe(true);
    expect(snapshotInserts.every(({ index }) => index < qualification)).toBe(true);
    expect(qualification).toBeLessThan(activation);
    expect(mockQueryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(mockQueryRunner.rollbackTransaction).not.toHaveBeenCalled();
  });

  it('returns only the immutable ACTIVE generation for an identical operation replay', async () => {
    const intent = forecastIntent();
    const proof = compileFeedingForecastGenerationExactSetProofV1(
      intent.snapshots.map((snapshot) => ({
        siteScopeKey: snapshot.siteScopeKey,
        poolScope: snapshot.poolScope,
        payload: snapshot,
      })),
    );
    const { mockDataSource, mockManager } = createMockDataSource();
    mockManager.query.mockImplementation((sql: string) => {
      if (sql.includes(`FROM "${FEEDING_FORECAST_GENERATION_AUTHORITY.activePointer.relation}"`)) {
        return Promise.resolve([{ generationId: NEW_GENERATION }]);
      }
      if (sql.includes('SELECT COUNT(*)::int AS count')) return Promise.resolve([{ count: 2 }]);
      if (
        sql.includes(`INSERT INTO "${FEEDING_FORECAST_GENERATION_AUTHORITY.generationRelation}"`)
      ) {
        return Promise.resolve([]);
      }
      if (sql.includes(`FROM "${FEEDING_FORECAST_GENERATION_AUTHORITY.generationRelation}"`)) {
        return Promise.resolve([
          {
            id: NEW_GENERATION,
            state: 'ACTIVE',
            exactSetDigest: proof.exactSetDigest,
            snapshotCount: 2,
          },
        ]);
      }
      return Promise.resolve([]);
    });

    await expect(
      runInTenantTransaction(mockDataSource, 'farm', TENANT, (_queryRunner, session) =>
        composition.feedingMutations.reconcileForecastProjection(session, intent),
      ),
    ).resolves.toEqual({
      generationId: NEW_GENERATION,
      exactSetDigest: proof.exactSetDigest,
      writtenCount: 2,
      retiredSnapshotCount: 0,
      replayed: true,
    });
    expect(
      mockManager.query.mock.calls.some(([sql]) =>
        String(sql).includes(
          `INSERT INTO "${FEEDING_FORECAST_GENERATION_AUTHORITY.snapshotRelation}"`,
        ),
      ),
    ).toBe(false);
    expect(
      mockManager.query.mock.calls.some(([sql]) =>
        String(sql).includes(FEEDING_FORECAST_GENERATION_AUTHORITY.mutationFunctions.qualify),
      ),
    ).toBe(false);
  });

  it('rejects a duplicate scope before any generation can be minted', async () => {
    const intent = forecastIntent();
    const { mockDataSource, mockManager, mockQueryRunner } = createMockDataSource();

    await expect(
      runInTenantTransaction(mockDataSource, 'farm', TENANT, (_queryRunner, session) =>
        composition.feedingMutations.reconcileForecastProjection(session, {
          ...intent,
          snapshots: [intent.snapshots[0]!, intent.snapshots[0]!],
        }),
      ),
    ).rejects.toThrow(`Duplicate forecast generation scope ${SITE}`);
    expect(mockManager.query).not.toHaveBeenCalled();
    expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(mockQueryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  it('purges only retired generations behind an active successor', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    mockManager.query.mockResolvedValue([{ count: 7 }]);
    const cutoff = new Date('2026-07-01T00:00:00.000Z');

    await expect(
      runInTenantTransaction(mockDataSource, 'farm', TENANT, (_queryRunner, session) =>
        composition.feedingMutations.purgeForecastProjectionBefore(session, cutoff),
      ),
    ).resolves.toBe(7);
    expect(mockManager.query).toHaveBeenCalledWith(
      expect.stringContaining(FEEDING_FORECAST_GENERATION_AUTHORITY.mutationFunctions.purgeRetired),
      [TENANT, cutoff],
    );
    const retentionStatement = String(mockManager.query.mock.calls[0]?.[0]);
    expect(retentionStatement).not.toContain('DELETE FROM');
  });
});
