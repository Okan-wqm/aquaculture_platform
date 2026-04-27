/**
 * TransferCleanerFishHandler — Transactional Outbox Unit Tests
 *
 * Final cleaner-fish lifecycle symmetry piece (deploy → mortality →
 * transfer → remove). The handler's five domain writes (source/dest
 * TankBatch, source/dest TankOperation rows, Batch metadata bump)
 * + the new `CleanerFishTransferred` outbox enqueue run atomically
 * in a single DataSource transaction.
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
import type { DataSource, EntityManager, QueryRunner, Repository } from 'typeorm';

import { TransferCleanerFishHandler } from '../../handlers/transfer-cleaner-fish.handler';
import { TransferCleanerFishCommand } from '../../commands/transfer-cleaner-fish.command';
import { Batch, BatchType } from '../../entities/batch.entity';
import { TankBatch } from '../../entities/tank-batch.entity';
import { TankOperation } from '../../entities/tank-operation.entity';
import { Equipment } from '../../../equipment/entities/equipment.entity';
import { Species } from '../../../species/entities/species.entity';
import type { OutboxPublisher } from '@platform/outbox';

interface HarnessOpts {
  cleanerBatch?: Partial<Batch> | null;
  sourceTank?: Partial<Equipment> | null;
  destTank?: Partial<Equipment> | null;
  sourceTankBatch?: Partial<TankBatch> | null;
  destTankBatch?: Partial<TankBatch> | null;
  species?: Partial<Species> | null;
  enqueueImpl?: (event: unknown, em: EntityManager) => Promise<void>;
}

function makeHarness(opts: HarnessOpts = {}) {
  const cleanerBatch: Partial<Batch> =
    opts.cleanerBatch === null
      ? (null as unknown as Partial<Batch>)
      : {
          id: 'cleaner-batch-1',
          tenantId: 'tenant-1',
          batchNumber: 'CB-001',
          batchType: BatchType.CLEANER_FISH,
          speciesId: 'species-lumpfish',
          currentQuantity: 100,
          isActive: true,
          ...(opts.cleanerBatch ?? {}),
        };

  const sourceTank: Partial<Equipment> =
    opts.sourceTank === null
      ? (null as unknown as Partial<Equipment>)
      : {
          id: 'tank-src',
          tenantId: 'tenant-1',
          name: 'Tank A',
          code: 'T-A',
          isActive: true,
          volume: 100,
          ...(opts.sourceTank ?? {}),
        };

  const destTank: Partial<Equipment> =
    opts.destTank === null
      ? (null as unknown as Partial<Equipment>)
      : {
          id: 'tank-dst',
          tenantId: 'tenant-1',
          name: 'Tank B',
          code: 'T-B',
          isActive: true,
          volume: 120,
          ...(opts.destTank ?? {}),
        };

  const sourceTankBatch: Partial<TankBatch> | null =
    opts.sourceTankBatch === null
      ? null
      : ({
          id: 'tb-src',
          tenantId: 'tenant-1',
          tankId: 'tank-src',
          cleanerFishDetails: [
            {
              batchId: 'cleaner-batch-1',
              batchNumber: 'CB-001',
              speciesId: 'species-lumpfish',
              speciesName: 'Lumpfish',
              quantity: 40,
              initialQuantity: 40,
              avgWeightG: 50,
              biomassKg: 2,
              totalMortality: 0,
              mortalityRate: 0,
            } as unknown as NonNullable<TankBatch['cleanerFishDetails']>[number],
          ],
          cleanerFishQuantity: 40,
          cleanerFishBiomassKg: 2,
          densityKgM3: 0.02,
          totalBiomassKg: 0,
          ...(opts.sourceTankBatch ?? {}),
        } as TankBatch);

  const destTankBatch: Partial<TankBatch> | null =
    opts.destTankBatch === null
      ? null
      : opts.destTankBatch === undefined
        ? null
        : (opts.destTankBatch as TankBatch);

  const species: Partial<Species> | null =
    opts.species === null
      ? null
      : opts.species ?? {
          id: 'species-lumpfish',
          tenantId: 'tenant-1',
          commonName: 'Lumpfish',
        };

  const batchRepository = {
    findOne: jest.fn().mockResolvedValue(cleanerBatch),
  };
  let tankBatchFindCall = 0;
  const tankBatchRepository = {
    findOne: jest.fn(({ where }: { where: { tankId: string } }) => {
      tankBatchFindCall++;
      if (where.tankId === 'tank-src') return Promise.resolve(sourceTankBatch);
      return Promise.resolve(destTankBatch);
    }),
    create: jest.fn((p: Partial<TankBatch>) => ({ ...p }) as TankBatch),
  };
  const operationRepository = {
    create: jest.fn((p: unknown) => p as TankOperation),
  };
  let equipmentCall = 0;
  const equipmentRepository = {
    findOne: jest.fn(({ where }: { where: { id: string } }) => {
      equipmentCall++;
      if (where.id === 'tank-src') return Promise.resolve(sourceTank);
      return Promise.resolve(destTank);
    }),
  };
  const speciesRepository = {
    findOne: jest.fn().mockResolvedValue(species),
  };

  const managerSave = jest.fn(async (_: unknown, entity: unknown) => entity);
  const commit = jest.fn().mockResolvedValue(undefined);
  const rollback = jest.fn().mockResolvedValue(undefined);
  const release = jest.fn().mockResolvedValue(undefined);
  const queryRunner: Partial<QueryRunner> = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: commit,
    rollbackTransaction: rollback,
    release,
    manager: { save: managerSave } as unknown as EntityManager,
  };
  const dataSource: Partial<DataSource> = {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  };

  const enqueue = jest.fn(async (event: unknown, em: EntityManager) => {
    if (opts.enqueueImpl) return opts.enqueueImpl(event, em);
    return undefined;
  });
  const outboxPublisher = { enqueue } as unknown as OutboxPublisher;

  const handler = new TransferCleanerFishHandler(
    batchRepository as unknown as Repository<Batch>,
    tankBatchRepository as unknown as Repository<TankBatch>,
    operationRepository as unknown as Repository<TankOperation>,
    equipmentRepository as unknown as Repository<Equipment>,
    speciesRepository as unknown as Repository<Species>,
    dataSource as DataSource,
    outboxPublisher,
  );

  return { handler, enqueue, commit, rollback };
}

function makeCommand(overrides: Partial<{
  quantity: number;
  reason: string;
  sourceTankId: string;
  destinationTankId: string;
}> = {}) {
  return new TransferCleanerFishCommand(
    'tenant-1',
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
    expect(event['tenantId']).toBe('tenant-1');
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
      cleanerBatch: { batchType: BatchType.PRODUCTION } as Batch,
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
        tenantId: 'tenant-1',
        tankId: 'tank-src',
        cleanerFishDetails: [],
        cleanerFishQuantity: 0,
        cleanerFishBiomassKg: 0,
      } as unknown as TankBatch,
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
