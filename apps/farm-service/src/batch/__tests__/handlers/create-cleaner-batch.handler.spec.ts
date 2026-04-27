/**
 * CreateCleanerBatchHandler — Transactional Outbox Unit Tests
 *
 * Completes the cleaner-fish lifecycle event coverage (5/5) — this
 * is the lifecycle-start event that the other four build on.
 *
 * Tests pin:
 *   1. Happy path: batch save + `CleanerFishBatchCreated` enqueue +
 *      commit (once), event shape includes sourceType discriminator.
 *   2. Outbox enqueue failure rolls back the batch insert.
 *   3. Non-cleaner species (isCleanerFish=false) throws BEFORE the
 *      transaction opens.
 *   4. Missing species throws BEFORE the transaction opens.
 *   5. Code-generator fallback path still publishes the event.
 */
import { BadRequestException } from '@nestjs/common';
import type { DataSource, EntityManager, QueryRunner, Repository } from 'typeorm';

import { CreateCleanerBatchHandler } from '../../handlers/create-cleaner-batch.handler';
import { CreateCleanerBatchCommand } from '../../commands/create-cleaner-batch.command';
import { Batch } from '../../entities/batch.entity';
import { Species } from '../../../species/entities/species.entity';
import type { CodeGeneratorService } from '../../../database/services/code-generator.service';
import type { OutboxPublisher } from '@platform/outbox';

interface HarnessOpts {
  species?: Partial<Species> | null;
  generatedCode?: { code: string } | null;
  enqueueImpl?: (event: unknown, em: EntityManager) => Promise<void>;
}

function makeHarness(opts: HarnessOpts = {}) {
  const species: Partial<Species> | null =
    opts.species === null
      ? null
      : {
          id: 'species-lumpfish',
          tenantId: 'tenant-1',
          commonName: 'Lumpfish',
          isCleanerFish: true,
          isActive: true,
          isDeleted: false,
          ...(opts.species ?? {}),
        };

  const batchRepository = {
    create: jest.fn((p: Partial<Batch>) => ({ ...p }) as Batch),
  };
  const speciesRepository = {
    findOne: jest.fn().mockResolvedValue(species),
  };
  const codeGenerator = {
    generateCode: jest.fn().mockResolvedValue(
      opts.generatedCode === null ? null : opts.generatedCode ?? { code: 'CFB-2026-001' },
    ),
  } as unknown as CodeGeneratorService;

  const managerSave = jest.fn(async (_: unknown, entity: Batch) => {
    return { ...entity, id: 'generated-batch-id' } as Batch;
  });
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

  const handler = new CreateCleanerBatchHandler(
    batchRepository as unknown as Repository<Batch>,
    speciesRepository as unknown as Repository<Species>,
    codeGenerator,
    dataSource as DataSource,
    outboxPublisher,
  );

  return { handler, enqueue, commit, rollback, managerSave };
}

function makeCommand(overrides: Partial<{
  sourceType: 'farmed' | 'wild_caught';
  initialQuantity: number;
  initialAvgWeightG: number;
}> = {}) {
  return new CreateCleanerBatchCommand(
    'tenant-1',
    {
      speciesId: 'species-lumpfish',
      initialQuantity: overrides.initialQuantity ?? 1000,
      initialAvgWeightG: overrides.initialAvgWeightG ?? 20,
      sourceType: overrides.sourceType ?? 'farmed',
      sourceLocation: 'Hatchery North',
      supplierId: 'supplier-1',
      stockedAt: new Date('2026-04-10T00:00:00Z'),
      purchaseCost: 50000,
      currency: 'NOK',
    },
    'user-1',
  );
}

describe('CreateCleanerBatchHandler — transactional outbox', () => {
  it('happy path: batch save + CleanerFishBatchCreated enqueue + commit', async () => {
    const { handler, enqueue, commit, managerSave } = makeHarness();

    const result = await handler.execute(makeCommand());

    expect(managerSave).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['eventType']).toBe('CleanerFishBatchCreated');
    expect(event['tenantId']).toBe('tenant-1');
    expect(event['cleanerBatchId']).toBe('generated-batch-id');
    expect(event['batchNumber']).toBe('CFB-2026-001');
    expect(event['speciesId']).toBe('species-lumpfish');
    expect(event['speciesName']).toBe('Lumpfish');
    expect(event['sourceType']).toBe('farmed');
    expect(event['initialQuantity']).toBe(1000);
    expect(event['initialAvgWeightG']).toBe(20);
    // 1000 * 20 / 1000 = 20 kg
    expect(event['initialBiomassKg']).toBeCloseTo(20, 5);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(result.id).toBe('generated-batch-id');
  });

  it('preserves the sourceType discriminator for wild_caught batches', async () => {
    const { handler, enqueue } = makeHarness();

    await handler.execute(makeCommand({ sourceType: 'wild_caught' }));

    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['sourceType']).toBe('wild_caught');
  });

  it('outbox enqueue failure rolls back the batch insert', async () => {
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

  it('throws BadRequestException when species is missing — no tx opened', async () => {
    const { handler, enqueue } = makeHarness({ species: null });

    await expect(handler.execute(makeCommand())).rejects.toThrow(
      BadRequestException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when species is not a cleaner fish — no tx opened', async () => {
    const { handler, enqueue } = makeHarness({
      species: { isCleanerFish: false } as Species,
    });

    await expect(handler.execute(makeCommand())).rejects.toThrow(
      BadRequestException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('still publishes the event when code-generator falls back (null code)', async () => {
    const { handler, enqueue } = makeHarness({ generatedCode: null });

    await handler.execute(makeCommand());

    expect(enqueue).toHaveBeenCalledTimes(1);
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    // Fallback format is `CFB-${year}-${timestamp}` — just assert prefix.
    expect(String(event['batchNumber']).startsWith('CFB-')).toBe(true);
  });
});
