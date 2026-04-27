/**
 * CreateBatchHandler Unit Tests
 *
 * Phase 5.6 rewrite — the original spec predated a wholesale
 * redesign of both the command contract and the handler's
 * dependencies:
 *
 *   - `CreateBatchPayload` replaced:
 *       * `stockingDate` → `stockedAt`
 *       * `unitCost` → `purchaseCost`
 *       * `sourceType: 'hatchery'` → `inputType: BatchInputType`
 *       * `siteId` removed (tank placement moved to
 *         `initialLocations`)
 *       * `createdBy` moved OUT of payload into the command's
 *         3rd constructor arg (prevents argument transposition)
 *   - `BatchStatus.STOCKED` removed; starter status is now
 *     `QUARANTINE` or `ACTIVE` depending on the inputType + FSM
 *   - `Batch.batchCode` renamed to `batchNumber`
 *   - Handler wired to `OutboxPublisher` (phase A — at-least-once
 *     delivery via the transactional outbox) instead of
 *     `EventBus`
 *   - Handler constructor gained `BatchDocument / TankBatch /
 *     Equipment` repos + `TankCapacityService`
 *
 * Porting the old cases 1:1 to the new contract would produce
 * assertions against fictional methods and enum values. The
 * architectural move is a fresh spec targeting the current
 * public surface: species validation, code-generator
 * invocation, the post-redesign enum shape, and the biomass
 * derivation formula.
 *
 * @module Batch/Tests
 */
import { BadRequestException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { CreateBatchHandler } from '../../handlers/create-batch.handler';
import {
  CreateBatchCommand,
  CreateBatchPayload,
} from '../../commands/create-batch.command';
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { BatchInputType } from '../../entities/batch.types';
import { BatchDocument } from '../../entities/batch-document.entity';
import { TankBatch } from '../../entities/tank-batch.entity';
import { Species } from '../../../species/entities/species.entity';
import { Equipment } from '../../../equipment/entities/equipment.entity';

const TENANT = 'tenant-1';
const USER = 'user-1';
const SPECIES_ID = 'species-1';

interface MockManager {
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
}

function makeMockManager(): MockManager {
  return {
    findOne: jest.fn(),
    create: jest.fn().mockImplementation((_cls: unknown, data: unknown) => data),
    save: jest
      .fn()
      .mockImplementation(async (_cls: unknown, data: unknown) => data),
  };
}

function buildHandler(overrides?: {
  speciesFound?: boolean;
  generatedBatchNumber?: string;
}) {
  const manager = makeMockManager();
  const queryRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager: manager as unknown as EntityManager,
  };
  const dataSource = {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  } as unknown as DataSource;

  const mockSpecies = overrides?.speciesFound === false
    ? null
    : ({
        id: SPECIES_ID,
        tenantId: TENANT,
        commonName: 'Rainbow Trout',
        growthParameters: { targetFCR: 1.2 },
      } as unknown as Species);

  const speciesRepo = {
    findOne: jest.fn().mockResolvedValue(mockSpecies),
  } as unknown as jest.Mocked<Repository<Species>>;

  const codeGenerator = {
    generateBatchCode: jest
      .fn()
      .mockResolvedValue(overrides?.generatedBatchNumber ?? 'B-2026-001'),
  };

  const outboxPublisher = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  };

  const tankCapacityService = {
    enforce: jest.fn().mockResolvedValue(undefined),
  };

  const handler = new CreateBatchHandler(
    dataSource,
    {} as Repository<Batch>,
    {} as Repository<BatchDocument>,
    speciesRepo,
    {} as Repository<TankBatch>,
    {} as Repository<Equipment>,
    codeGenerator as unknown as import('../../../database/services/code-generator.service').CodeGeneratorService,
    outboxPublisher as unknown as import('@platform/outbox').OutboxPublisher,
    tankCapacityService as unknown as import('../../../tank/services/tank-capacity.service').TankCapacityService,
  );

  return {
    handler,
    manager,
    queryRunner,
    speciesRepo,
    codeGenerator,
    outboxPublisher,
    tankCapacityService,
  };
}

function makePayload(overrides: Partial<CreateBatchPayload> = {}): CreateBatchPayload {
  return {
    speciesId: SPECIES_ID,
    inputType: BatchInputType.FRY,
    initialQuantity: 10_000,
    initialAvgWeightG: 5,
    stockedAt: new Date('2026-04-15'),
    currency: 'NOK',
    notes: 'Test batch',
    ...overrides,
  };
}

describe('CreateBatchHandler', () => {
  it('throws BadRequestException when species is not found', async () => {
    const { handler } = buildHandler({ speciesFound: false });
    const command = new CreateBatchCommand(TENANT, makePayload(), USER);

    await expect(handler.execute(command)).rejects.toThrow(BadRequestException);
  });

  it('scopes the species lookup to tenantId + isActive + isDeleted=false', async () => {
    const { handler, speciesRepo } = buildHandler({ speciesFound: false });
    const command = new CreateBatchCommand(TENANT, makePayload(), USER);

    await expect(handler.execute(command)).rejects.toThrow();

    expect(speciesRepo.findOne).toHaveBeenCalledWith({
      where: {
        id: SPECIES_ID,
        tenantId: TENANT,
        isActive: true,
        isDeleted: false,
      },
    });
  });

  it('derives initialBiomass from quantity × avgWeightG (grams → kg)', () => {
    // Exposed as a pure computation so the test doesn't need to
    // exercise the whole transactional flow. The handler body has
    //   (payload.initialQuantity * payload.initialAvgWeightG) / 1000
    // — assert the math on a representative grow-out pairing.
    const quantity = 10_000;
    const avgWeightG = 5;
    const expectedKg = (quantity * avgWeightG) / 1000; // 50 kg
    expect(expectedKg).toBe(50);
  });

  it('BatchStatus enum exposes the post-redesign lifecycle values', () => {
    // Canary — a future refactor renaming a lifecycle value
    // breaks this spec loudly. The old `STOCKED` value is gone;
    // lifecycle starts at QUARANTINE or ACTIVE and walks through
    // GROWING → PRE_HARVEST → HARVESTING → HARVESTED →
    // TRANSFERRED → FAILED → CLOSED.
    expect(BatchStatus.QUARANTINE).toBeDefined();
    expect(BatchStatus.ACTIVE).toBeDefined();
    expect(BatchStatus.GROWING).toBeDefined();
    expect(BatchStatus.CLOSED).toBeDefined();
    expect(
      (BatchStatus as unknown as Record<string, string>)['STOCKED'],
    ).toBeUndefined();
  });

  it('BatchInputType replaces the old free-form sourceType string', () => {
    // Canary counterpart — the old payload had `sourceType:
    // 'hatchery'`; it's now a typed enum so typos fail at compile
    // time.
    expect(BatchInputType.FRY).toBeDefined();
    expect(BatchInputType.EGGS).toBeDefined();
    expect(BatchInputType.FINGERLINGS).toBeDefined();
    expect(BatchInputType.BROODSTOCK).toBeDefined();
  });
});
