/**
 * DeployCleanerFishHandler — Transactional Outbox Unit Tests
 *
 * Mirror of the `RemoveCleanerFishHandler` spec. The handler's three
 * domain writes (TankBatch upsert with new cleaner-fish detail, Batch
 * currentQuantity decrement, TankOperation audit row) now sit inside
 * a single DataSource transaction alongside the `CleanerFishDeployed`
 * outbox enqueue. These tests pin the contract:
 *
 *   1. Happy path — event carries the post-op tank snapshot + the
 *      cleaner-batch decrement + the welfare `isOverCapacity` flag.
 *   2. Outbox enqueue failure rolls back every domain write.
 *   3. Pre-transaction validations (missing batch, wrong batch type,
 *      missing tank, quantity over-spend) trip BEFORE a tx opens.
 *
 * The welfare capacity gate itself lives in `TankCapacityService` and
 * is tested there; this spec stubs the service.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager, QueryRunner, Repository } from 'typeorm';

import { DeployCleanerFishHandler } from '../../handlers/deploy-cleaner-fish.handler';
import { DeployCleanerFishCommand } from '../../commands/deploy-cleaner-fish.command';
import { Batch, BatchType } from '../../entities/batch.entity';
import { TankBatch } from '../../entities/tank-batch.entity';
import { TankOperation } from '../../entities/tank-operation.entity';
import { Equipment } from '../../../equipment/entities/equipment.entity';
import { Species } from '../../../species/entities/species.entity';
import type { TankCapacityService } from '../../../tank/services/tank-capacity.service';
import type { OutboxPublisher } from '@platform/outbox';

interface HarnessOpts {
  cleanerBatch?: Partial<Batch> | null;
  tank?: Partial<Equipment> | null;
  tankBatch?: Partial<TankBatch> | null;
  species?: Partial<Species> | null;
  capacityResult?: { isOverCapacity: boolean };
  capacityThrows?: Error;
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
          sourceType: 'farmed',
          currentQuantity: 100,
          isActive: true,
          getCurrentAvgWeight: () => 50,
          ...(opts.cleanerBatch ?? {}),
        } as unknown as Partial<Batch>;

  const tank: Partial<Equipment> =
    opts.tank === null
      ? (null as unknown as Partial<Equipment>)
      : {
          id: 'tank-1',
          tenantId: 'tenant-1',
          name: 'Tank A',
          code: 'T-A',
          isActive: true,
          volume: 100,
          ...(opts.tank ?? {}),
        };

  const tankBatch: Partial<TankBatch> | null =
    opts.tankBatch === null ? null : opts.tankBatch ?? null;

  const species: Partial<Species> | null =
    opts.species === null ? null : opts.species ?? {
      id: 'species-lumpfish',
      tenantId: 'tenant-1',
      commonName: 'Lumpfish',
    };

  const batchRepository = {
    findOne: jest.fn().mockResolvedValue(cleanerBatch),
  };
  const tankBatchRepository = {
    findOne: jest.fn().mockResolvedValue(tankBatch),
    create: jest.fn((p: Partial<TankBatch>) => ({ ...p }) as TankBatch),
  };
  const operationRepository = {
    create: jest.fn((p: unknown) => p as TankOperation),
    findOne: jest.fn(),
  };
  const equipmentRepository = {
    findOne: jest.fn().mockResolvedValue(tank),
  };
  const speciesRepository = {
    findOne: jest.fn().mockResolvedValue(species),
  };

  const capacityResult = opts.capacityResult ?? { isOverCapacity: false };
  const enforce = jest.fn(() => {
    if (opts.capacityThrows) throw opts.capacityThrows;
    return capacityResult;
  });
  const tankCapacityService = { enforce } as unknown as TankCapacityService;

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

  const handler = new DeployCleanerFishHandler(
    batchRepository as unknown as Repository<Batch>,
    tankBatchRepository as unknown as Repository<TankBatch>,
    operationRepository as unknown as Repository<TankOperation>,
    equipmentRepository as unknown as Repository<Equipment>,
    speciesRepository as unknown as Repository<Species>,
    tankCapacityService,
    dataSource as DataSource,
    outboxPublisher,
  );

  return { handler, enqueue, commit, rollback };
}

function makeCommand(overrides: Partial<{
  quantity: number;
  avgWeightG: number;
}> = {}) {
  return new DeployCleanerFishCommand(
    'tenant-1',
    {
      cleanerBatchId: 'cleaner-batch-1',
      targetTankId: 'tank-1',
      quantity: overrides.quantity ?? 30,
      avgWeightG: overrides.avgWeightG,
      deployedAt: new Date('2026-04-10T09:00:00Z'),
    },
    'user-1',
  );
}

describe('DeployCleanerFishHandler — transactional outbox', () => {
  it('happy path: emits CleanerFishDeployed with post-op snapshot + decremented cleanerBatch stock', async () => {
    const { handler, enqueue, commit } = makeHarness();

    await handler.execute(makeCommand({ quantity: 30 }));

    expect(enqueue).toHaveBeenCalledTimes(1);
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event.eventType).toBe('CleanerFishDeployed');
    expect(event.cleanerBatchId).toBe('cleaner-batch-1');
    expect(event.targetTankId).toBe('tank-1');
    expect(event.tenantId).toBe('tenant-1');
    expect(event.speciesName).toBe('Lumpfish');
    expect(event.quantity).toBe(30);
    // 30 × 50 g / 1000 = 1.5 kg
    expect(event.biomassKg).toBeCloseTo(1.5, 5);
    // 100 - 30 = 70 remaining in the cleaner batch
    expect(event.newCleanerBatchCurrentQuantity).toBe(70);
    // Fresh tankBatch starts at 0 + 30 = 30
    expect(event.newTankCleanerFishQuantity).toBe(30);
    expect(event.isOverCapacity).toBe(false);

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

  it('BadRequestException when requested quantity exceeds cleaner-batch stock — no tx opened', async () => {
    const { handler, enqueue } = makeHarness();

    await expect(
      handler.execute(makeCommand({ quantity: 9999 })),
    ).rejects.toThrow(BadRequestException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('NotFoundException when target tank is missing — no tx opened', async () => {
    const { handler, enqueue } = makeHarness({ tank: null });

    await expect(handler.execute(makeCommand())).rejects.toThrow(
      NotFoundException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('propagates a welfare capacity rejection from TankCapacityService BEFORE tx opens', async () => {
    const { handler, enqueue } = makeHarness({
      capacityThrows: new BadRequestException('density exceeds maxDensity'),
    });

    await expect(handler.execute(makeCommand())).rejects.toThrow(
      'density exceeds maxDensity',
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
});
