import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { FEEDING_RECORD_WRITE_PROVENANCE_AUTHORITY } from '@aquaculture/feeding-contracts';
import { createMockDataSource } from '@aquaculture/testing';

import {
  createFarmDurableMutationTestComposition,
  type FarmDurableMutationTestComposition,
} from '../../__tests__/support/durable-mutation-test-authority';
import { FeedingRecord } from '../../feeding/entities/feeding-record.entity';

const TENANT = '11111111-1111-4111-8111-111111111111';
const RECORD = '22222222-2222-4222-8222-222222222222';
const OPERATION = '33333333-3333-4333-8333-333333333333';
const MUTATION_INSTANT = '2026-08-09T12:00:00.000Z';

function record(): FeedingRecord {
  return Object.assign(new FeedingRecord(), {
    id: RECORD,
    tenantId: TENANT,
  });
}

describe('FeedingAggregateMutationPort feeding-record write provenance', () => {
  let composition: FarmDurableMutationTestComposition;

  beforeAll(async () => {
    composition = await createFarmDurableMutationTestComposition();
  });

  afterAll(async () => {
    await composition.close();
  });

  function harness(provenanceRows: readonly { provenance_digest: string }[] = [
    { provenance_digest: 'a'.repeat(64) },
  ]) {
    const result = createMockDataSource();
    result.mockQueryRunner.query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes('transaction_timestamp()')
          ? [{ mutationInstant: MUTATION_INSTANT }]
          : [],
      ),
    );
    result.mockManager.query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes(FEEDING_RECORD_WRITE_PROVENANCE_AUTHORITY.appendFunction)
          ? [...provenanceRows]
          : [],
      ),
    );
    return result;
  }

  it('stamps the persisted operation and closed runtime origin after the row write', async () => {
    const { mockDataSource, mockManager } = harness();
    const aggregate = record();

    const saved = await runInTenantTransaction(
      mockDataSource,
      'farm',
      TENANT,
      (_queryRunner, session) =>
        composition.feedingMutations.commitFeedingRecordTransition(session, {
          intent: 'recorded',
          aggregate,
          provenance: { operationId: OPERATION, origin: 'RUNTIME_OPERATION' },
        }),
    );

    expect(saved).toBe(aggregate);
    expect(mockManager.save).toHaveBeenCalledWith(aggregate);
    expect(mockManager.query).toHaveBeenCalledWith(
      expect.stringContaining(FEEDING_RECORD_WRITE_PROVENANCE_AUTHORITY.appendFunction),
      [TENANT, RECORD, OPERATION, 'RUNTIME_OPERATION', new Date(MUTATION_INSTANT)],
    );
    expect(mockManager.save.mock.invocationCallOrder[0]).toBeLessThan(
      mockManager.query.mock.invocationCallOrder[0]!,
    );
  });

  it('does not rewrite first-write provenance during a correction', async () => {
    const { mockDataSource, mockManager } = harness();

    await runInTenantTransaction(mockDataSource, 'farm', TENANT, (_queryRunner, session) =>
      composition.feedingMutations.commitFeedingRecordTransition(session, {
        intent: 'corrected',
        aggregate: record(),
      }),
    );

    expect(mockManager.query).not.toHaveBeenCalled();
  });

  it('fails the transaction when the database append authority returns no proof', async () => {
    const { mockDataSource, mockQueryRunner } = harness([]);

    await expect(
      runInTenantTransaction(mockDataSource, 'farm', TENANT, (_queryRunner, session) =>
        composition.feedingMutations.commitFeedingRecordTransition(session, {
          intent: 'recorded',
          aggregate: record(),
          provenance: { operationId: OPERATION, origin: 'LIVE_DRAIN' },
        }),
      ),
    ).rejects.toThrow('write provenance append returned no proof');
    expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(mockQueryRunner.commitTransaction).not.toHaveBeenCalled();
  });
});
