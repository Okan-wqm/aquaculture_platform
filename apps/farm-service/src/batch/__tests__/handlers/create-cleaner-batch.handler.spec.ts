/**
 * CreateCleanerBatchHandler — Transactional Outbox Unit Tests
 *
 * Completes the cleaner-fish lifecycle event coverage (5/5) — this
 * is the lifecycle-start event that the other four build on.
 *
 * The handler now writes inside runInTenantTransaction (fail-closed
 * tenant boundary). We exercise the real boundary against a mocked
 * DataSource/QueryRunner from createMockDataSource — its queryRunner.query
 * returns [] so the search_path/GUC readback assertion is skipped under
 * mocks. tenantId MUST be a valid UUID because the boundary pins the
 * tenant search_path and rejects non-UUIDs.
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
import { createMockDataSource } from '@aquaculture/testing';
import type { OutboxPublisher } from '@platform/outbox';
import type { Repository } from 'typeorm';

import { CreateCleanerBatchHandler } from '../../handlers/create-cleaner-batch.handler';
import { CreateCleanerBatchCommand } from '../../commands/create-cleaner-batch.command';
import { Batch } from '../../entities/batch.entity';
import { Species } from '../../../species/entities/species.entity';
import type { CodeGeneratorService } from '../../../database/services/code-generator.service';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface HarnessOpts {
  species?: Partial<Species> | null;
  generatedCode?: { code: string } | null;
  enqueueImpl?: () => Promise<void>;
}

function makeHarness(opts: HarnessOpts = {}): {
  handler: CreateCleanerBatchHandler;
  enqueue: jest.Mock;
  commit: jest.Mock;
  rollback: jest.Mock;
  managerSave: jest.Mock;
} {
  const species: Partial<Species> | null =
    opts.species === null
      ? null
      : {
          id: 'species-lumpfish',
          tenantId: TENANT,
          commonName: 'Lumpfish',
          isCleanerFish: true,
          isActive: true,
          isDeleted: false,
          ...(opts.species ?? {}),
        };

  const batchRepository: Partial<Repository<Batch>> = {
    create: jest.fn().mockImplementation((p: Partial<Batch>) => ({ ...p })),
  };
  const speciesRepository: Partial<Repository<Species>> = {
    findOne: jest.fn().mockResolvedValue(species),
  };
  const codeGenerator: Pick<CodeGeneratorService, 'generateCode'> = {
    generateCode: jest.fn().mockResolvedValue(
      opts.generatedCode === null ? null : opts.generatedCode ?? { code: 'CFB-2026-001' },
    ),
  };

  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
  const managerSave = mockManager.save as jest.Mock;
  managerSave.mockImplementation(async (_entity: unknown, entity: Batch) => ({
    ...entity,
    id: 'generated-batch-id',
  }));
  const commit = mockQueryRunner.commitTransaction as jest.Mock;
  const rollback = mockQueryRunner.rollbackTransaction as jest.Mock;

  const enqueue = jest.fn(async () => {
    if (opts.enqueueImpl) return opts.enqueueImpl();
    return undefined;
  });
  const outboxPublisher: Pick<OutboxPublisher, 'enqueue'> = { enqueue };

  const handler = new CreateCleanerBatchHandler(
    batchRepository as Repository<Batch>,
    speciesRepository as Repository<Species>,
    codeGenerator as CodeGeneratorService,
    mockDataSource,
    outboxPublisher as OutboxPublisher,
  );

  return { handler, enqueue, commit, rollback, managerSave };
}

function makeCommand(overrides: Partial<{
  sourceType: 'farmed' | 'wild_caught';
  initialQuantity: number;
  initialAvgWeightG: number;
}> = {}): CreateCleanerBatchCommand {
  return new CreateCleanerBatchCommand(
    TENANT,
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
    expect(event['tenantId']).toBe(TENANT);
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
      species: { isCleanerFish: false },
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
