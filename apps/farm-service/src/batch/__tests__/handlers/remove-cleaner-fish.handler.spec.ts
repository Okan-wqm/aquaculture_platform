/**
 * RemoveCleanerFishHandler — Transactional Outbox Unit Tests
 *
 * The handler wraps three domain writes (TankBatch stock decrement,
 * Batch quantity roll-forward on `relocation`, TankOperation audit
 * row) AND a `CleanerFishRemoved` outbox enqueue inside
 * runInTenantTransaction (fail-closed tenant boundary). We exercise the
 * real boundary against a mocked DataSource/QueryRunner from
 * createMockDataSource — its queryRunner.query returns [] so the
 * search_path/GUC readback is skipped. tenantId MUST be a valid UUID
 * because the boundary pins the tenant search_path and rejects non-UUIDs.
 *
 * These tests pin the contract the outbox enqueue depends on:
 *
 *   1. Happy path emits a `CleanerFishRemoved` event with the
 *      post-operation stock snapshot + reason code the command
 *      supplied.
 *   2. `relocation` reason re-adds quantity to `cleanerBatch.currentQuantity`
 *      — verify the event reflects the ROLLED-FORWARD value.
 *   3. Outbox enqueue failure rolls back every domain write (no
 *      partial state, no stale event).
 *   4. Validation throws (bad batch type / quantity over-spend /
 *      tank mismatch) trip BEFORE the transaction starts.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createMockDataSource } from '@aquaculture/testing';
import type { OutboxPublisher } from '@platform/outbox';
import type { Repository } from 'typeorm';

import { RemoveCleanerFishHandler } from '../../handlers/remove-cleaner-fish.handler';
import {
  RemoveCleanerFishCommand,
  type CleanerFishRemovalReason,
} from '../../commands/remove-cleaner-fish.command';
import { Batch, BatchType } from '../../entities/batch.entity';
import { TankBatch, CleanerFishDetail } from '../../entities/tank-batch.entity';
import { TankOperation } from '../../entities/tank-operation.entity';
import { Equipment } from '../../../equipment/entities/equipment.entity';
import { Species } from '../../../species/entities/species.entity';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface HarnessOpts {
  cleanerBatch?: Partial<Batch> | null;
  tank?: Partial<Equipment> | null;
  tankBatch?: Partial<TankBatch> | null;
  species?: Partial<Species> | null;
  enqueueImpl?: () => Promise<void>;
}

function makeDetail(overrides: Partial<CleanerFishDetail> = {}): CleanerFishDetail {
  return {
    batchId: 'cleaner-batch-1',
    batchNumber: 'CB-001',
    speciesId: 'species-lumpfish',
    speciesName: 'Lumpfish',
    quantity: 60,
    initialQuantity: 60,
    avgWeightG: 50,
    biomassKg: 3,
    sourceType: 'farmed',
    deployedAt: new Date('2026-04-01T00:00:00Z'),
    totalMortality: 0,
    mortalityRate: 0,
    ...overrides,
  };
}

function makeHarness(opts: HarnessOpts = {}): {
  handler: RemoveCleanerFishHandler;
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
          currentQuantity: 100,
          isActive: true,
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
    opts.tankBatch === null
      ? null
      : {
          id: 'tb-1',
          tenantId: TENANT,
          tankId: 'tank-1',
          cleanerFishDetails: [makeDetail()],
          cleanerFishQuantity: 60,
          cleanerFishBiomassKg: 3,
          densityKgM3: 0.03,
          totalBiomassKg: 0,
          ...(opts.tankBatch ?? {}),
        };

  const species: Partial<Species> | null =
    opts.species === null
      ? null
      : {
          id: 'species-lumpfish',
          tenantId: TENANT,
          commonName: 'Lumpfish',
          ...(opts.species ?? {}),
        };

  const batchRepository: Partial<Repository<Batch>> = {
    findOne: jest.fn().mockResolvedValue(cleanerBatch),
  };
  const tankBatchRepository: Partial<Repository<TankBatch>> = {
    findOne: jest.fn().mockResolvedValue(tankBatch),
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

  const { mockDataSource, mockQueryRunner } = createMockDataSource();
  const commit = mockQueryRunner.commitTransaction as jest.Mock;
  const rollback = mockQueryRunner.rollbackTransaction as jest.Mock;

  const enqueue = jest.fn(async () => {
    if (opts.enqueueImpl) return opts.enqueueImpl();
    return undefined;
  });
  const outboxPublisher: Pick<OutboxPublisher, 'enqueue'> = { enqueue };

  const handler = new RemoveCleanerFishHandler(
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
  reason: CleanerFishRemovalReason;
  notes: string;
}> = {}): RemoveCleanerFishCommand {
  return new RemoveCleanerFishCommand(
    TENANT,
    {
      cleanerBatchId: 'cleaner-batch-1',
      tankId: 'tank-1',
      quantity: overrides.quantity ?? 20,
      avgWeightG: 50,
      reason: overrides.reason ?? 'end_of_cycle',
      removedAt: new Date('2026-04-10T09:00:00Z'),
      notes: overrides.notes,
    },
    'user-1',
  );
}

describe('RemoveCleanerFishHandler — transactional outbox', () => {
  it('happy path: publishes CleanerFishRemoved event with post-operation stock snapshot', async () => {
    const { handler, enqueue, commit } = makeHarness();

    await handler.execute(makeCommand());

    expect(enqueue).toHaveBeenCalledTimes(1);
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['eventType']).toBe('CleanerFishRemoved');
    expect(event['cleanerBatchId']).toBe('cleaner-batch-1');
    expect(event['tankId']).toBe('tank-1');
    expect(event['tenantId']).toBe(TENANT);
    expect(event['quantity']).toBe(20);
    expect(event['reason']).toBe('end_of_cycle');
    expect(event['speciesName']).toBe('Lumpfish');
    expect(event['biomassKg']).toBeCloseTo(1, 5); // 20 * 50 / 1000 = 1 kg
    // Post-op: tank had 60 cleaner fish; removed 20 → 40 left.
    expect(event['newTankCleanerFishQuantity']).toBe(40);
    // Non-relocation reasons leave cleanerBatch.currentQuantity
    // untouched (the fish are consumed / end-of-cycle / harvested).
    expect(event['newCleanerBatchCurrentQuantity']).toBe(100);

    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('relocation reason rolls quantity forward on cleanerBatch AND reflects it in the event', async () => {
    const { handler, enqueue } = makeHarness();

    await handler.execute(
      makeCommand({ quantity: 10, reason: 'relocation' }),
    );

    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    // 100 (original) + 10 (returned via relocation) = 110
    expect(event['newCleanerBatchCurrentQuantity']).toBe(110);
    expect(event['reason']).toBe('relocation');
  });

  it('outbox enqueue failure rolls back every domain write', async () => {
    const { handler, commit, rollback } = makeHarness({
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

  it('throws NotFoundException when cleaner batch is missing — no tx opened', async () => {
    const { handler, enqueue } = makeHarness({ cleanerBatch: null });

    await expect(handler.execute(makeCommand())).rejects.toThrow(
      NotFoundException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when batch is not a CLEANER_FISH batch — no tx opened', async () => {
    const { handler, enqueue } = makeHarness({
      cleanerBatch: { batchType: BatchType.PRODUCTION },
    });

    await expect(handler.execute(makeCommand())).rejects.toThrow(
      BadRequestException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when requested quantity exceeds the in-tank stock — no tx opened', async () => {
    const { handler, enqueue } = makeHarness();

    await expect(
      handler.execute(makeCommand({ quantity: 9999 })),
    ).rejects.toThrow(BadRequestException);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
