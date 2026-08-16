/**
 * DeployCleanerFishHandler — Transactional Outbox Unit Tests
 *
 * The handler's three domain writes (TankBatch upsert with new cleaner-fish
 * detail, Batch currentQuantity decrement, TankOperation audit row) now sit
 * inside runInTenantTransaction (fail-closed tenant boundary) alongside the
 * `CleanerFishDeployed` outbox enqueue. We exercise the real boundary against
 * a mocked DataSource/QueryRunner from createMockDataSource — its
 * queryRunner.query returns [] so the search_path/GUC readback is skipped.
 * tenantId MUST be a valid UUID because the boundary pins the tenant
 * search_path and rejects non-UUIDs.
 *
 * Tests pin:
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
import { createMockDataSource } from '@aquaculture/testing';
import type { OutboxPublisher } from '@platform/outbox';
import type { Repository } from 'typeorm';

import { DeployCleanerFishHandler } from '../../handlers/deploy-cleaner-fish.handler';
import { DeployCleanerFishCommand } from '../../commands/deploy-cleaner-fish.command';
import { Batch, BatchType } from '../../entities/batch.entity';
import { TankBatch } from '../../entities/tank-batch.entity';
import { TankOperation } from '../../entities/tank-operation.entity';
import { Equipment } from '../../../equipment/entities/equipment.entity';
import { Species } from '../../../species/entities/species.entity';
import type { TankCapacityService } from '../../../tank/services/tank-capacity.service';
import { RecordingBatchAggregateMutationPort } from '../../../__tests__/support/durable-mutation-test-authority';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface HarnessOpts {
  cleanerBatch?: Partial<Batch> | null;
  tank?: Partial<Equipment> | null;
  tankBatch?: Partial<TankBatch> | null;
  species?: Partial<Species> | null;
  capacityResult?: { isOverCapacity: boolean };
  capacityThrows?: Error;
  enqueueImpl?: () => Promise<void>;
}

function makeHarness(opts: HarnessOpts = {}): {
  handler: DeployCleanerFishHandler;
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
          getCurrentAvgWeight: () => 50,
          ...(opts.cleanerBatch ?? {}),
        };

  const tank: Partial<Equipment> | null =
    opts.tank === null
      ? null
      : {
          id: 'tank-1',
          tenantId: TENANT,
          name: 'Tank A',
          code: 'T-A',
          isActive: true,
          volume: 100,
          ...(opts.tank ?? {}),
        };

  const tankBatch: Partial<TankBatch> | null =
    opts.tankBatch === null ? null : (opts.tankBatch ?? null);

  const species: Partial<Species> | null =
    opts.species === null
      ? null
      : (opts.species ?? {
          id: 'species-lumpfish',
          tenantId: TENANT,
          commonName: 'Lumpfish',
        });

  const batchRepository: Partial<Repository<Batch>> = {
    findOne: jest.fn().mockResolvedValue(cleanerBatch),
  };
  const tankBatchRepository: Partial<Repository<TankBatch>> = {
    findOne: jest.fn().mockResolvedValue(tankBatch),
    create: jest.fn().mockImplementation((p: Partial<TankBatch>) => ({ ...p })),
  };
  const operationRepository: Partial<Repository<TankOperation>> = {
    create: jest.fn().mockImplementation((p: Partial<TankOperation>) => p),
  };
  const equipmentRepository: Partial<Repository<Equipment>> = {
    findOne: jest.fn().mockResolvedValue(tank),
  };
  const speciesRepository: Partial<Repository<Species>> = {
    findOne: jest.fn().mockResolvedValue(species),
  };

  const capacityResult = opts.capacityResult ?? { isOverCapacity: false };
  const enforce = jest.fn().mockImplementation(() => {
    if (opts.capacityThrows) throw opts.capacityThrows;
    return capacityResult;
  });
  const tankCapacityService: Partial<TankCapacityService> = { enforce };

  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
  const commit = mockQueryRunner.commitTransaction as jest.Mock;
  const rollback = mockQueryRunner.rollbackTransaction as jest.Mock;

  const enqueue = jest.fn(async () => {
    if (opts.enqueueImpl) return opts.enqueueImpl();
    return undefined;
  });
  const outboxPublisher: Pick<OutboxPublisher, 'enqueue'> = { enqueue };

  const handler = new DeployCleanerFishHandler(
    new RecordingBatchAggregateMutationPort(mockManager),
    batchRepository as Repository<Batch>,
    tankBatchRepository as Repository<TankBatch>,
    operationRepository as Repository<TankOperation>,
    equipmentRepository as Repository<Equipment>,
    speciesRepository as Repository<Species>,
    tankCapacityService as TankCapacityService,
    mockDataSource,
    outboxPublisher as OutboxPublisher,
  );

  return { handler, enqueue, commit, rollback };
}

function makeCommand(
  overrides: Partial<{
    quantity: number;
    avgWeightG: number;
  }> = {},
): DeployCleanerFishCommand {
  return new DeployCleanerFishCommand(
    TENANT,
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
    expect(event['eventType']).toBe('CleanerFishDeployed');
    expect(event['cleanerBatchId']).toBe('cleaner-batch-1');
    expect(event['targetTankId']).toBe('tank-1');
    expect(event['tenantId']).toBe(TENANT);
    expect(event['speciesName']).toBe('Lumpfish');
    expect(event['quantity']).toBe(30);
    // 30 × 50 g / 1000 = 1.5 kg
    expect(event['biomassKg']).toBeCloseTo(1.5, 5);
    // 100 - 30 = 70 remaining in the cleaner batch
    expect(event['newCleanerBatchCurrentQuantity']).toBe(70);
    // Fresh tankBatch starts at 0 + 30 = 30
    expect(event['newTankCleanerFishQuantity']).toBe(30);
    expect(event['isOverCapacity']).toBe(false);

    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('outbox enqueue failure rolls back every domain write', async () => {
    const { handler, rollback, commit } = makeHarness({
      enqueueImpl: async () => {
        throw new Error('outbox-enqueue-failed');
      },
    });

    await expect(handler.execute(makeCommand())).rejects.toThrow('outbox-enqueue-failed');
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it('NotFoundException on missing cleaner batch — no tx opened', async () => {
    const { handler, enqueue } = makeHarness({ cleanerBatch: null });

    await expect(handler.execute(makeCommand())).rejects.toThrow(NotFoundException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('BadRequestException when batch is not CLEANER_FISH — no tx opened', async () => {
    const { handler, enqueue } = makeHarness({
      cleanerBatch: { batchType: BatchType.PRODUCTION },
    });

    await expect(handler.execute(makeCommand())).rejects.toThrow(BadRequestException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('BadRequestException when requested quantity exceeds cleaner-batch stock — no tx opened', async () => {
    const { handler, enqueue } = makeHarness();

    await expect(handler.execute(makeCommand({ quantity: 9999 }))).rejects.toThrow(
      BadRequestException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('NotFoundException when target tank is missing — no tx opened', async () => {
    const { handler, enqueue } = makeHarness({ tank: null });

    await expect(handler.execute(makeCommand())).rejects.toThrow(NotFoundException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('propagates a welfare capacity rejection from TankCapacityService BEFORE tx opens', async () => {
    const { handler, enqueue } = makeHarness({
      capacityThrows: new BadRequestException('density exceeds maxDensity'),
    });

    await expect(handler.execute(makeCommand())).rejects.toThrow('density exceeds maxDensity');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
