/**
 * RemoveCleanerFishHandler — Transactional Outbox Unit Tests
 *
 * The handler wraps three domain writes (TankBatch stock decrement,
 * Batch quantity roll-forward on `relocation`, TankOperation audit
 * row) AND a new `CleanerFishRemoved` outbox enqueue in a single
 * DataSource transaction.
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
 *
 * The handler does its own read-validation outside the tx and we
 * keep that path intact — those failures reject with the existing
 * NestJS exceptions. The tests assert the reject happens and the
 * outbox was never touched.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager, QueryRunner, Repository } from 'typeorm';

import { RemoveCleanerFishHandler } from '../../handlers/remove-cleaner-fish.handler';
import {
  RemoveCleanerFishCommand,
  type CleanerFishRemovalReason,
} from '../../commands/remove-cleaner-fish.command';
import { Batch, BatchType } from '../../entities/batch.entity';
import { TankBatch } from '../../entities/tank-batch.entity';
import { TankOperation } from '../../entities/tank-operation.entity';
import { Equipment } from '../../../equipment/entities/equipment.entity';
import { Species } from '../../../species/entities/species.entity';
import type { OutboxPublisher } from '@platform/outbox';

interface HarnessOpts {
  cleanerBatch?: Partial<Batch> | null;
  tank?: Partial<Equipment> | null;
  tankBatch?: Partial<TankBatch> | null;
  species?: Partial<Species> | null;
  enqueueImpl?: (event: unknown, em: EntityManager) => Promise<void>;
  saveImpl?: (Entity: unknown, entity: unknown) => Promise<unknown>;
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

  const tankBatch: Partial<TankBatch> =
    opts.tankBatch === null
      ? (null as unknown as Partial<TankBatch>)
      : {
          id: 'tb-1',
          tenantId: 'tenant-1',
          tankId: 'tank-1',
          cleanerFishDetails: [
            {
              batchId: 'cleaner-batch-1',
              speciesName: 'Lumpfish',
              quantity: 60,
              avgWeightG: 50,
              biomassKg: 3,
            } as unknown as NonNullable<TankBatch['cleanerFishDetails']>[number],
          ],
          cleanerFishQuantity: 60,
          cleanerFishBiomassKg: 3,
          densityKgM3: 0.03,
          totalBiomassKg: 0,
          ...(opts.tankBatch ?? {}),
        };

  const species: Partial<Species> =
    opts.species === null
      ? (null as unknown as Partial<Species>)
      : {
          id: 'species-lumpfish',
          tenantId: 'tenant-1',
          commonName: 'Lumpfish',
          ...(opts.species ?? {}),
        };

  const findOneResults: Record<string, unknown> = {
    Batch: cleanerBatch,
    Equipment: tank,
    TankBatch: tankBatch,
    Species: species,
  };

  const batchRepository = {
    findOne: jest.fn().mockResolvedValue(findOneResults.Batch),
  };
  const tankBatchRepository = {
    findOne: jest.fn().mockResolvedValue(findOneResults.TankBatch),
  };
  const operationRepository = {
    create: jest.fn((payload: unknown) => payload as TankOperation),
    findOne: jest.fn(),
  };
  const equipmentRepository = {
    findOne: jest.fn().mockResolvedValue(findOneResults.Equipment),
  };
  const speciesRepository = {
    findOne: jest.fn().mockResolvedValue(findOneResults.Species),
  };

  const managerSave = jest.fn(
    async (Entity: unknown, entity: unknown): Promise<unknown> => {
      if (opts.saveImpl) return opts.saveImpl(Entity, entity);
      return entity;
    },
  );
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

  const handler = new RemoveCleanerFishHandler(
    batchRepository as unknown as Repository<Batch>,
    tankBatchRepository as unknown as Repository<TankBatch>,
    operationRepository as unknown as Repository<TankOperation>,
    equipmentRepository as unknown as Repository<Equipment>,
    speciesRepository as unknown as Repository<Species>,
    dataSource as DataSource,
    outboxPublisher,
  );

  return {
    handler,
    enqueue,
    commit,
    rollback,
    release,
    managerSave,
  };
}

function makeCommand(overrides: Partial<{
  quantity: number;
  reason: CleanerFishRemovalReason;
  notes: string;
}> = {}) {
  return new RemoveCleanerFishCommand(
    'tenant-1',
    {
      cleanerBatchId: 'cleaner-batch-1',
      tankId: 'tank-1',
      quantity: overrides.quantity ?? 20,
      avgWeightG: 50,
      reason: overrides.reason ?? 'end_of_cycle',
      removedAt: new Date('2026-04-10T09:00:00Z'),
      notes: overrides.notes,
    } as unknown as RemoveCleanerFishCommand['payload'],
    'user-1',
  );
}

describe('RemoveCleanerFishHandler — transactional outbox', () => {
  it('happy path: publishes CleanerFishRemoved event with post-operation stock snapshot', async () => {
    const { handler, enqueue, commit } = makeHarness();

    await handler.execute(makeCommand());

    expect(enqueue).toHaveBeenCalledTimes(1);
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event.eventType).toBe('CleanerFishRemoved');
    expect(event.cleanerBatchId).toBe('cleaner-batch-1');
    expect(event.tankId).toBe('tank-1');
    expect(event.tenantId).toBe('tenant-1');
    expect(event.quantity).toBe(20);
    expect(event.reason).toBe('end_of_cycle');
    expect(event.speciesName).toBe('Lumpfish');
    expect(event.biomassKg).toBeCloseTo(1, 5); // 20 * 50 / 1000 = 1 kg
    // Post-op: tank had 60 cleaner fish; removed 20 → 40 left.
    expect(event.newTankCleanerFishQuantity).toBe(40);
    // Non-relocation reasons leave cleanerBatch.currentQuantity
    // untouched (the fish are consumed / end-of-cycle / harvested).
    expect(event.newCleanerBatchCurrentQuantity).toBe(100);

    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('relocation reason rolls quantity forward on cleanerBatch AND reflects it in the event', async () => {
    const { handler, enqueue } = makeHarness();

    await handler.execute(
      makeCommand({ quantity: 10, reason: 'relocation' }),
    );

    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    // 100 (original) + 10 (returned via relocation) = 110
    expect(event.newCleanerBatchCurrentQuantity).toBe(110);
    expect(event.reason).toBe('relocation');
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
      cleanerBatch: { batchType: BatchType.PRODUCTION } as Batch,
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
