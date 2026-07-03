/**
 * TransferCleanerFishHandler — Transactional Outbox Unit Tests
 *
 * The handler's five domain writes (source/dest TankBatch, source/dest
 * TankOperation rows, Batch metadata bump) + the `CleanerFishTransferred`
 * outbox enqueue run atomically inside runInTenantTransaction (fail-closed
 * tenant boundary). We exercise the real boundary against a mocked
 * DataSource/QueryRunner from createMockDataSource — its queryRunner.query
 * returns [] so the search_path/GUC readback is skipped. tenantId MUST be a
 * valid UUID because the boundary pins the tenant search_path and rejects
 * non-UUIDs.
 *
 * Tests pin:
 *   1. Happy path: event carries BOTH source and destination post-op
 *      stock snapshots so projections patch atomically.
 *   2. Outbox enqueue failure rolls back every domain write.
 *   3. Pre-transaction validations (missing cleaner batch, wrong
 *      batch type, same source/destination tank, missing source
 *      tank, missing source TankBatch, batch-not-in-tank, quantity
 *      over-spend, missing destination tank) trip BEFORE the tx
 *      opens and never touch the outbox.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createMockDataSource } from '@aquaculture/testing';
import type { OutboxPublisher } from '@platform/outbox';
import type { FindOneOptions, Repository } from 'typeorm';

import { TransferCleanerFishHandler } from '../../handlers/transfer-cleaner-fish.handler';
import { TransferCleanerFishCommand } from '../../commands/transfer-cleaner-fish.command';
import { Batch, BatchType } from '../../entities/batch.entity';
import { TankBatch, CleanerFishDetail } from '../../entities/tank-batch.entity';
import { TankOperation } from '../../entities/tank-operation.entity';
import { Equipment } from '../../../equipment/entities/equipment.entity';
import { Species } from '../../../species/entities/species.entity';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface HarnessOpts {
  cleanerBatch?: Partial<Batch> | null;
  sourceTank?: Partial<Equipment> | null;
  destTank?: Partial<Equipment> | null;
  sourceTankBatch?: Partial<TankBatch> | null;
  destTankBatch?: Partial<TankBatch> | null;
  species?: Partial<Species> | null;
  enqueueImpl?: () => Promise<void>;
}

function makeSourceDetail(overrides: Partial<CleanerFishDetail> = {}): CleanerFishDetail {
  return {
    batchId: 'cleaner-batch-1',
    batchNumber: 'CB-001',
    speciesId: 'species-lumpfish',
    speciesName: 'Lumpfish',
    quantity: 40,
    initialQuantity: 40,
    avgWeightG: 50,
    biomassKg: 2,
    sourceType: 'farmed',
    deployedAt: new Date('2026-04-01T00:00:00Z'),
    totalMortality: 0,
    mortalityRate: 0,
    ...overrides,
  };
}

function whereId(options?: FindOneOptions<Equipment>): string | undefined {
  const where = options?.where as { id?: string } | undefined;
  return where?.id;
}

function whereTankId(options?: FindOneOptions<TankBatch>): string | undefined {
  const where = options?.where as { tankId?: string } | undefined;
  return where?.tankId;
}

function makeHarness(opts: HarnessOpts = {}): {
  handler: TransferCleanerFishHandler;
  enqueue: jest.Mock;
  commit: jest.Mock;
  rollback: jest.Mock;
} {
  const cleanerBatch: Partial<Batch> | null =
    opts.cleanerBatch === null
      ? null
      : {
          id: 'cleaner-batch-1',
          tenantId: TENANT,
          batchNumber: 'CB-001',
          batchType: BatchType.CLEANER_FISH,
          speciesId: 'species-lumpfish',
          sourceType: 'farmed',
          currentQuantity: 100,
          isActive: true,
          ...(opts.cleanerBatch ?? {}),
        };

  const sourceTank: Partial<Equipment> | null =
    opts.sourceTank === null
      ? null
      : {
          id: 'tank-src',
          tenantId: TENANT,
          name: 'Tank A',
          code: 'T-A',
          isActive: true,
          volume: 100,
          ...(opts.sourceTank ?? {}),
        };

  const destTank: Partial<Equipment> | null =
    opts.destTank === null
      ? null
      : {
          id: 'tank-dst',
          tenantId: TENANT,
          name: 'Tank B',
          code: 'T-B',
          isActive: true,
          volume: 120,
          ...(opts.destTank ?? {}),
        };

  const sourceTankBatch: Partial<TankBatch> | null =
    opts.sourceTankBatch === null
      ? null
      : {
          id: 'tb-src',
          tenantId: TENANT,
          tankId: 'tank-src',
          cleanerFishDetails: [makeSourceDetail()],
          cleanerFishQuantity: 40,
          cleanerFishBiomassKg: 2,
          densityKgM3: 0.02,
          totalBiomassKg: 0,
          ...(opts.sourceTankBatch ?? {}),
        };

  const destTankBatch: Partial<TankBatch> | null = opts.destTankBatch ?? null;

  const species: Partial<Species> | null =
    opts.species === null ? null : opts.species ?? {
      id: 'species-lumpfish',
      tenantId: TENANT,
      commonName: 'Lumpfish',
    };

  const batchRepository: Partial<Repository<Batch>> = {
    findOne: jest.fn().mockResolvedValue(cleanerBatch),
  };
  const tankBatchRepository: Partial<Repository<TankBatch>> = {
    findOne: jest.fn().mockImplementation((options?: FindOneOptions<TankBatch>) =>
      Promise.resolve(whereTankId(options) === 'tank-src' ? sourceTankBatch : destTankBatch),
    ),
    create: jest.fn().mockImplementation((p: Partial<TankBatch>) => ({ ...p })),
  };
  const operationRepository: Partial<Repository<TankOperation>> = {
    create: jest.fn().mockImplementation((p: Partial<TankOperation>) => p),
  };
  const equipmentRepository: Partial<Repository<Equipment>> = {
    findOne: jest.fn().mockImplementation((options?: FindOneOptions<Equipment>) =>
      Promise.resolve(whereId(options) === 'tank-src' ? sourceTank : destTank),
    ),
  };
  const speciesRepository: Partial<Repository<Species>> = {
    findOne: jest.fn().mockResolvedValue(species),
  };

  const { mockDataSource, mockQueryRunner } = createMockDataSource();
  const commit = mockQueryRunner.commitTransaction as jest.Mock;
  const rollback = mockQueryRunner.rollbackTransaction as jest.Mock;

  const enqueue = jest.fn(async () => {
    if (opts.enqueueImpl) return opts.enqueueImpl();
    return undefined;
  });
  const outboxPublisher: Pick<OutboxPublisher, 'enqueue'> = { enqueue };

  const handler = new TransferCleanerFishHandler(
    batchRepository as Repository<Batch>,
    tankBatchRepository as Repository<TankBatch>,
    operationRepository as Repository<TankOperation>,
    equipmentRepository as Repository<Equipment>,
    speciesRepository as Repository<Species>,
    mockDataSource,
    outboxPublisher as OutboxPublisher,
  );

  return { handler, enqueue, commit, rollback };
}

function makeCommand(overrides: Partial<{
  quantity: number;
  reason: string;
  sourceTankId: string;
  destinationTankId: string;
}> = {}): TransferCleanerFishCommand {
  return new TransferCleanerFishCommand(
    TENANT,
    {
      cleanerBatchId: 'cleaner-batch-1',
      sourceTankId: overrides.sourceTankId ?? 'tank-src',
      destinationTankId: overrides.destinationTankId ?? 'tank-dst',
      quantity: overrides.quantity ?? 15,
      transferredAt: new Date('2026-04-10T09:00:00Z'),
      reason: overrides.reason,
    },
    'user-1',
  );
}

describe('TransferCleanerFishHandler — transactional outbox', () => {
  it('happy path: emits CleanerFishTransferred with both source and destination post-op snapshots', async () => {
    const { handler, enqueue, commit } = makeHarness();

    await handler.execute(makeCommand({ quantity: 15, reason: 'rebalance' }));

    expect(enqueue).toHaveBeenCalledTimes(1);
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['eventType']).toBe('CleanerFishTransferred');
    expect(event['cleanerBatchId']).toBe('cleaner-batch-1');
    expect(event['sourceTankId']).toBe('tank-src');
    expect(event['destinationTankId']).toBe('tank-dst');
    expect(event['tenantId']).toBe(TENANT);
    expect(event['speciesName']).toBe('Lumpfish');
    expect(event['quantity']).toBe(15);
    expect(event['reason']).toBe('rebalance');
    // 15 * 50 g / 1000 = 0.75 kg
    expect(event['biomassKg']).toBeCloseTo(0.75, 5);
    // Source had 40, transferred out 15 → 25 left
    expect(event['newSourceTankCleanerFishQuantity']).toBe(25);
    // Destination starts fresh (null tankBatch → created with 0 → +15 = 15)
    expect(event['newDestinationTankCleanerFishQuantity']).toBe(15);

    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('outbox enqueue failure rolls back every domain write', async () => {
    const { handler, rollback, commit } = makeHarness({
      enqueueImpl: async () => {
        throw new Error('outbox-enqueue-failed');
      },
    });

    await expect(handler.execute(makeCommand())).rejects.toThrow(
      'outbox-enqueue-failed',
    );
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it('NotFoundException on missing cleaner batch — no tx opened', async () => {
    const { handler, enqueue } = makeHarness({ cleanerBatch: null });
    await expect(handler.execute(makeCommand())).rejects.toThrow(
      NotFoundException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('BadRequestException when batch is not CLEANER_FISH — no tx opened', async () => {
    const { handler, enqueue } = makeHarness({
      cleanerBatch: { batchType: BatchType.PRODUCTION },
    });
    await expect(handler.execute(makeCommand())).rejects.toThrow(
      BadRequestException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('BadRequestException when source and destination tanks are the same — no tx opened', async () => {
    const { handler, enqueue } = makeHarness();
    await expect(
      handler.execute(
        makeCommand({ sourceTankId: 'tank-src', destinationTankId: 'tank-src' }),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('NotFoundException when source tank is missing — no tx opened', async () => {
    const { handler, enqueue } = makeHarness({ sourceTank: null });
    await expect(handler.execute(makeCommand())).rejects.toThrow(
      NotFoundException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('NotFoundException when source TankBatch is missing — no tx opened', async () => {
    const { handler, enqueue } = makeHarness({ sourceTankBatch: null });
    await expect(handler.execute(makeCommand())).rejects.toThrow(
      NotFoundException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('BadRequestException when the cleaner batch is not present in the source tank — no tx opened', async () => {
    const { handler, enqueue } = makeHarness({
      sourceTankBatch: {
        id: 'tb-src',
        tenantId: TENANT,
        tankId: 'tank-src',
        cleanerFishDetails: [],
        cleanerFishQuantity: 0,
        cleanerFishBiomassKg: 0,
      },
    });
    await expect(handler.execute(makeCommand())).rejects.toThrow(
      BadRequestException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('BadRequestException on quantity over-spend — no tx opened', async () => {
    const { handler, enqueue } = makeHarness();
    await expect(
      handler.execute(makeCommand({ quantity: 9999 })),
    ).rejects.toThrow(BadRequestException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('NotFoundException when destination tank is missing — no tx opened', async () => {
    const { handler, enqueue } = makeHarness({ destTank: null });
    await expect(handler.execute(makeCommand())).rejects.toThrow(
      NotFoundException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
});
