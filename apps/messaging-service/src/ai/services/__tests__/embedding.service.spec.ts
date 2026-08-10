/**
 * The embedding sweep reads a PER-TENANT table from a cron.
 *
 * ORPHAN-HIGH-585: `messages` lives in `tenant_<uuid>` (messaging-service omits
 * `schema:`), and a `@Cron` has no HTTP request behind it, so nothing seeds the
 * tenant frame and an unqualified `FROM "messages"` resolved against whatever
 * search_path the pooled connection happened to carry. Which tenant's rows got
 * embedded was decided by whoever used that connection last.
 *
 * The second defect found with it: `FOR UPDATE SKIP LOCKED` ran under
 * `dataSource.query`, i.e. autocommit, so the row locks were released the
 * instant the SELECT returned. Two replicas could still claim the same rows —
 * a lock that ends before the work it guards is not a lock.
 *
 * These tests pin both, plus the property that made the old shape defensible:
 * one failed write must not take the batch down with it (MSG-MEDIUM-041).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';

import { EmbeddingService } from '../embedding.service';
import { AiEgressGateService } from '../ai-egress-gate.service';
import { createMockNatsClient, fakeUuid, resetUuidCounter, MockNatsClient } from '../../../__tests__/test-helpers';

const SCHEMA_A = 'tenant_aaaaaaaaaaaaaaaa';
const SCHEMA_B = 'tenant_bbbbbbbbbbbbbbbb';

interface RecordedQuery {
  readonly sql: string;
  readonly params?: unknown[];
}

/**
 * A query runner that records every statement and answers the message SELECT
 * from a per-schema script, so a test can say what each tenant holds.
 */
function createRunner(rowsBySchema: Map<string, unknown[]>, failUpdateForId?: string) {
  const recorded: RecordedQuery[] = [];
  let pinnedSchema = '';
  const runner = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    isTransactionActive: true,
    query: jest.fn((sql: string, params?: unknown[]) => {
      recorded.push({ sql, params });
      if (sql.includes('set_config') && params) {
        // The helper passes one string: `"tenant_x", "messaging", public`.
        pinnedSchema = /"([^"]+)"/.exec(String(params[0]))?.[1] ?? '';
        return Promise.resolve([]);
      }
      if (sql.includes('FROM "messages"')) {
        return Promise.resolve(rowsBySchema.get(pinnedSchema) ?? []);
      }
      if (sql.startsWith('UPDATE "messages"') && failUpdateForId && params?.[1] === failUpdateForId) {
        return Promise.reject(new Error('vector write refused'));
      }
      return Promise.resolve([]);
    }),
  };
  return { runner, recorded, pinned: () => pinnedSchema };
}

function createDataSource(schemas: string[], runnerLike: object) {
  return {
    query: jest.fn().mockResolvedValue(schemas.map((schema_name) => ({ schema_name }))),
    createQueryRunner: jest.fn().mockReturnValue(runnerLike),
  };
}

async function buildService(dataSource: object, natsClient: MockNatsClient, allowed = true) {
  const egressGate = { isAllowed: jest.fn().mockResolvedValue(allowed) };
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      EmbeddingService,
      { provide: DataSource, useValue: dataSource },
      { provide: 'NATS_SERVICE', useValue: natsClient },
      { provide: AiEgressGateService, useValue: egressGate },
    ],
  }).compile();
  return { service: module.get(EmbeddingService), egressGate };
}

function message(senderId: string, tenantId: string) {
  return {
    id: fakeUuid('msg'),
    channelId: fakeUuid('ch'),
    senderId,
    content: 'hello',
    createdAt: new Date('2026-08-06T00:00:00Z'),
    tenantId,
  };
}

describe('EmbeddingService — per-tenant schema binding', () => {
  let natsClient: MockNatsClient;

  beforeEach(() => {
    resetUuidCounter();
    natsClient = createMockNatsClient();
    natsClient.send.mockReturnValue(of({ embeddings: [[0.1, 0.2, 0.3]] }));
  });

  it('pins each tenant schema before reading messages', async () => {
    // The defect: without this the table name resolves against the pooled
    // connection's leftover search_path.
    const { runner, recorded } = createRunner(new Map());
    const { service } = await buildService(createDataSource([SCHEMA_A], runner), natsClient);

    await service.processUnembeddedMessages();

    const pin = recorded.findIndex((q) => q.sql.includes('set_config'));
    const read = recorded.findIndex((q) => q.sql.includes('FROM "messages"'));
    expect(pin).toBeGreaterThanOrEqual(0);
    expect(recorded[pin]?.params).toEqual([`"${SCHEMA_A}", "messaging", public`]);
    // Order is the whole point: a pin after the read is a read that never had it.
    expect(pin).toBeLessThan(read);
  });

  it('visits every tenant schema, not just whichever one the connection had', async () => {
    const { runner, recorded } = createRunner(new Map());
    const { service } = await buildService(createDataSource([SCHEMA_A, SCHEMA_B], runner), natsClient);

    await service.processUnembeddedMessages();

    const pinned = recorded
      .filter((q) => q.sql.includes('set_config'))
      .map((q) => /"([^"]+)"/.exec(String(q.params?.[0]))?.[1]);
    expect(pinned).toEqual([SCHEMA_A, SCHEMA_B]);
  });

  it('holds the transaction across the embedding call so SKIP LOCKED means something', async () => {
    const sender = fakeUuid('usr');
    const rows = new Map([[SCHEMA_A, [message(sender, 'tenant-a')]]]);
    const { runner, recorded } = createRunner(rows);
    const { service } = await buildService(createDataSource([SCHEMA_A], runner), natsClient);

    await service.processUnembeddedMessages();

    expect(recorded.some((q) => q.sql.includes('FOR UPDATE OF m SKIP LOCKED'))).toBe(true);
    // The write-back happens on the SAME runner, inside the same transaction
    // that took the locks. Under the previous autocommit shape the locks were
    // already gone by now.
    expect(recorded.some((q) => q.sql.startsWith('UPDATE "messages"'))).toBe(true);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
    const commitOrder = runner.commitTransaction.mock.invocationCallOrder[0] ?? 0;
    const sendOrder = natsClient.send.mock.invocationCallOrder[0] ?? 0;
    expect(sendOrder).toBeLessThan(commitOrder);
  });

  it('isolates a failed write with a savepoint instead of losing the batch', async () => {
    // MSG-MEDIUM-041: one bad row used to be survivable because every write was
    // its own autocommit statement. Now that the batch shares a transaction,
    // the savepoint is what keeps that true.
    const sender = fakeUuid('usr');
    const first = message(sender, 'tenant-a');
    const second = message(sender, 'tenant-a');
    const rows = new Map([[SCHEMA_A, [first, second]]]);
    const { runner, recorded } = createRunner(rows, first.id);
    natsClient.send.mockReturnValue(of({ embeddings: [[0.1], [0.2]] }));
    const { service } = await buildService(createDataSource([SCHEMA_A], runner), natsClient);

    await service.processUnembeddedMessages();

    expect(recorded.some((q) => q.sql.startsWith('ROLLBACK TO SAVEPOINT'))).toBe(true);
    expect(recorded.some((q) => q.sql.startsWith('RELEASE SAVEPOINT'))).toBe(true);
    // The good row still landed, and the tenant's transaction still committed.
    const updates = recorded.filter((q) => q.sql.startsWith('UPDATE "messages"'));
    expect(updates).toHaveLength(2);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('reads no messages when the platform has no tenant schemas', async () => {
    const { runner, recorded } = createRunner(new Map());
    const { service } = await buildService(createDataSource([], runner), natsClient);

    await service.processUnembeddedMessages();

    expect(recorded).toEqual([]);
    expect(runner.connect).not.toHaveBeenCalled();
  });

  it('still asks the consent gate per sender, with the tenant from the row', async () => {
    const sender = fakeUuid('usr');
    const rows = new Map([[SCHEMA_A, [message(sender, 'tenant-a')]]]);
    const { runner } = createRunner(rows);
    const { service, egressGate } = await buildService(
      createDataSource([SCHEMA_A], runner),
      natsClient,
      false,
    );

    await service.processUnembeddedMessages();

    expect(egressGate.isAllowed).toHaveBeenCalledWith('tenant-a', sender, 'embedding');
    // Refused consent means nothing is sent to ai-service at all.
    expect(natsClient.send).not.toHaveBeenCalled();
  });

  it('one tenant failure does not stop the sweep reaching the next', async () => {
    const rows = new Map<string, unknown[]>();
    const { runner, recorded } = createRunner(rows);
    runner.query.mockImplementationOnce(() => Promise.reject(new Error('schema vanished')));
    const { service } = await buildService(createDataSource([SCHEMA_A, SCHEMA_B], runner), natsClient);

    await service.processUnembeddedMessages();

    expect(runner.rollbackTransaction).toHaveBeenCalled();
    expect(recorded.some((q) => String(q.params?.[0]).includes(SCHEMA_B))).toBe(true);
  });
});
