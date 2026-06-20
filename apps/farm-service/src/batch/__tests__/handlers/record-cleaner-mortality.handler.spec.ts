/**
 * RecordCleanerMortalityHandler — Transactional Outbox Unit Tests
 *
 * Completes the cleaner-fish lifecycle event coverage
 * (deploy → mortality → transfer → remove). The handler's four
 * domain writes (TankBatch update, Batch cumulative mortality
 * increment, MortalityRecord row, TankOperation audit row) + the
 * new `CleanerFishMortalityRecorded` outbox enqueue run in one
 * DataSource transaction.
 *
 * Tests pin:
 *
 *   1. Happy path: event carries post-op tank snapshot + cumulative
 *      batch totals + normalised UPPER_SNAKE reason.
 *   2. Lowercase input reason maps correctly to the event contract's
 *      enum code.
 *   3. Unknown reason label falls back to 'UNKNOWN' — event emission
 *      is not blocked.
 *   4. Outbox enqueue failure rolls back every domain write.
 *   5. Pre-transaction validations (wrong batch type, over-spend,
 *      missing tank / batch / TankBatch, batch-not-in-tank) trip
 *      BEFORE the tx opens; the outbox is never touched.
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager, QueryRunner, Repository } from 'typeorm';

import { RecordCleanerMortalityHandler } from '../../handlers/record-cleaner-mortality.handler';
import { RecordCleanerMortalityCommand } from '../../commands/record-cleaner-mortality.command';
import { Batch, BatchType } from '../../entities/batch.entity';
import { TankBatch } from '../../entities/tank-batch.entity';
import { TankOperation } from '../../entities/tank-operation.entity';
import { MortalityRecord } from '../../entities/mortality-record.entity';
import { Equipment } from '../../../equipment/entities/equipment.entity';
import { Species } from '../../../species/entities/species.entity';
import type { OutboxPublisher } from '@platform/outbox';
import { MortalityCullPolicyService } from '../../services/mortality-cull-policy.service';

interface HarnessOpts {
  cleanerBatch?: Partial<Batch> | null;
  tank?: Partial<Equipment> | null;
  tankBatch?: Partial<TankBatch> | null;
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
          initialQuantity: 1000,
          currentQuantity: 900,
          totalMortality: 100,
          isActive: true,
          isOperational: jest.fn().mockReturnValue(true),
          isStockMutable: jest.fn().mockReturnValue(true),
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

  const tankBatch: Partial<TankBatch> | null =
    opts.tankBatch === null
      ? null
      : ({
          id: 'tb-1',
          tenantId: 'tenant-1',
          tankId: 'tank-1',
          cleanerFishDetails: [
            {
              batchId: 'cleaner-batch-1',
              batchNumber: 'CB-001',
              speciesId: 'species-lumpfish',
              speciesName: 'Lumpfish',
              quantity: 60,
              initialQuantity: 60,
              avgWeightG: 50,
              biomassKg: 3,
              totalMortality: 0,
              mortalityRate: 0,
            } as unknown as NonNullable<TankBatch['cleanerFishDetails']>[number],
          ],
          cleanerFishQuantity: 60,
          cleanerFishBiomassKg: 3,
          densityKgM3: 0.03,
          totalBiomassKg: 0,
          ...(opts.tankBatch ?? {}),
        } as TankBatch);

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
  const tankBatchRepository = {
    findOne: jest.fn().mockResolvedValue(tankBatch),
  };
  const operationRepository = {
    create: jest.fn((p: unknown) => p as TankOperation),
  };
  const mortalityRepository = {
    create: jest.fn((p: unknown) => p as MortalityRecord),
  };
  const equipmentRepository = {
    findOne: jest.fn().mockResolvedValue(tank),
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

  const handler = new RecordCleanerMortalityHandler(
    batchRepository as unknown as Repository<Batch>,
    tankBatchRepository as unknown as Repository<TankBatch>,
    operationRepository as unknown as Repository<TankOperation>,
    mortalityRepository as unknown as Repository<MortalityRecord>,
    equipmentRepository as unknown as Repository<Equipment>,
    speciesRepository as unknown as Repository<Species>,
    dataSource as DataSource,
    outboxPublisher,
    new MortalityCullPolicyService(),
  );

  return { handler, enqueue, commit, rollback };
}

function makeCommand(overrides: Partial<{
  quantity: number;
  reason: string;
  detail: string;
}> = {}) {
  return new RecordCleanerMortalityCommand(
    'tenant-1',
    {
      cleanerBatchId: 'cleaner-batch-1',
      tankId: 'tank-1',
      quantity: overrides.quantity ?? 10,
      reason: overrides.reason ?? 'disease',
      detail: overrides.detail,
      observedAt: new Date('2026-04-10T09:00:00Z'),
    },
    'user-1',
  );
}

describe('RecordCleanerMortalityHandler — transactional outbox', () => {
  it('happy path: emits CleanerFishMortalityRecorded with post-op snapshot + uppercase reason', async () => {
    const { handler, enqueue, commit } = makeHarness();

    await handler.execute(makeCommand({ quantity: 10, reason: 'disease' }));

    expect(enqueue).toHaveBeenCalledTimes(1);
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['eventType']).toBe('CleanerFishMortalityRecorded');
    expect(event['cleanerBatchId']).toBe('cleaner-batch-1');
    expect(event['tankId']).toBe('tank-1');
    expect(event['tenantId']).toBe('tenant-1');
    expect(event['quantity']).toBe(10);
    expect(event['speciesName']).toBe('Lumpfish');
    // 10 * 50 / 1000 = 0.5 kg
    expect(event['biomassKg']).toBeCloseTo(0.5, 5);
    // Lowercase 'disease' → contract's uppercase 'DISEASE'
    expect(event['reason']).toBe('DISEASE');
    // Tank had 60 cleaner fish; 10 died → 50 left
    expect(event['newTankCleanerFishQuantity']).toBe(50);
    // Cleaner batch: 100 previous mortality + 10 = 110 cumulative
    expect(event['newCleanerBatchTotalMortality']).toBe(110);
    // initialQuantity 1000 → 110 / 1000 * 100 = 11%
    expect(event['newCleanerBatchMortalityRate']).toBeCloseTo(11, 5);

    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('normalises every common lowercase reason to its uppercase counterpart', async () => {
    const pairs = [
      ['water_quality', 'WATER_QUALITY'],
      ['stress', 'STRESS'],
      ['handling', 'HANDLING'],
      ['temperature', 'TEMPERATURE'],
      ['oxygen', 'OXYGEN'],
      ['unknown', 'UNKNOWN'],
      ['other', 'OTHER'],
    ] as const;

    for (const [input, expected] of pairs) {
      const { handler, enqueue } = makeHarness();
      await handler.execute(makeCommand({ reason: input, quantity: 1 }));
      expect(enqueue).toHaveBeenCalledTimes(1);
      const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
      expect(event['reason']).toBe(expected);
    }
  });

  it('falls back to UNKNOWN when the reason label is not in the enum set', async () => {
    const { handler, enqueue } = makeHarness();

    await handler.execute(
      makeCommand({ reason: 'some-new-label-not-in-enum', quantity: 1 }),
    );

    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['reason']).toBe('UNKNOWN');
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

  it('BadRequestException on wrong batch type — no tx opened', async () => {
    const { handler, enqueue } = makeHarness({
      cleanerBatch: { batchType: BatchType.PRODUCTION } as Batch,
    });
    await expect(handler.execute(makeCommand())).rejects.toThrow(
      BadRequestException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ConflictException on terminal cleaner batch — no tx opened', async () => {
    const { handler, enqueue } = makeHarness({
      cleanerBatch: {
        isActive: true,
        isOperational: jest.fn().mockReturnValue(false),
        isStockMutable: jest.fn().mockReturnValue(false),
      } as Partial<Batch>,
    });

    await expect(handler.execute(makeCommand())).rejects.toThrow(
      ConflictException,
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

  it('NotFoundException when TankBatch is missing — no tx opened', async () => {
    const { handler, enqueue } = makeHarness({ tankBatch: null });
    await expect(handler.execute(makeCommand())).rejects.toThrow(
      NotFoundException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
});
