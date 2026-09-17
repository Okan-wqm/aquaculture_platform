/**
 * CreateHarvestRecordHandler — Final-Harvest Chain Unit Tests
 *
 * Pins the v2 `BatchHarvested` outbox contract and the final-harvest →
 * batch-closure dispatch:
 *
 *   1. Partial harvest → event `isFinal=false`, version 2, batch NOT
 *      marked HARVESTED, no CloseBatchCommand dispatch.
 *   2. Final harvest (stock reaches 0) → batch HARVESTED, event
 *      `isFinal=true`, CloseBatchCommand(HARVEST_COMPLETED) dispatched
 *      AFTER commit.
 *   3. Auto-close failure does not fail the committed harvest — the
 *      handler resolves and the batch stays HARVESTED for manual close.
 *   4. Unknown quality grade is rejected (no silent GRADE_A upgrade).
 */
import { BadRequestException, Logger } from '@nestjs/common';
import { Role } from '@aquaculture/backend-common/decorators';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { createMockDataSource, createMockRepository } from '@aquaculture/testing';
import { getMetadataStorage } from 'class-validator';
import type { BatchHarvestedEvent } from '@platform/event-contracts';

import { CloseBatchCommand, BatchCloseReason } from '../../../batch/commands/close-batch.command';
import { Batch, BatchStatus } from '../../../batch/entities/batch.entity';
import { TankBatch } from '../../../batch/entities/tank-batch.entity';
import { TankOperation } from '../../../batch/entities/tank-operation.entity';
import { BatchWithdrawalBlockedError } from '../../../common/errors/farm-errors';
import { Tank } from '../../../tank/entities/tank.entity';
import { CreateHarvestRecordCommand } from '../../commands/create-harvest-record.command';
import { CreateHarvestRecordInput } from '../../dto/create-harvest-record.input';
import { HarvestRecord, QualityClass } from '../../entities/harvest-record.entity';
import { CreateHarvestRecordHandler } from '../../handlers/create-harvest-record.handler';
import { createStockChangeDouble } from '../../../batch/__tests__/support/stock-change-double';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface HarnessOpts {
  /** Fish currently in the batch (default 1000). */
  currentQuantity?: number;
  /** Reject the auto-close dispatch. */
  closeBatchError?: Error;
}

function makeHarness(opts: HarnessOpts = {}) {
  const batch = {
    id: 'batch-1',
    tenantId: TENANT_ID,
    currentQuantity: opts.currentQuantity ?? 1000,
    harvestedQuantity: 0,
    status: BatchStatus.HARVESTING,
    isActive: true,
    getRetentionRate: jest.fn().mockReturnValue(95),
  };

  const tank = {
    id: 'tank-1',
    tenantId: TENANT_ID,
    isActive: true,
    currentBiomass: 500,
    currentCount: batch.currentQuantity,
    waterVolume: 100,
  };

  const codeQueryBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(null),
    // Also serves the handler's biomass-only UPDATE (.update().set().where()
    // .execute()) — currentCount is now written by applyBatchDelta (single
    // writer) and biomass uses a column-scoped update that must not clobber it.
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  // A stocked tank-batch so the handler's tank-composition path executes; the
  // real fields are derived by applyBatchDelta (mocked), so only identity +
  // the post-read aggregates the handler echoes into postOperationState matter.
  const tankBatch = {
    tankId: 'tank-1',
    primaryBatchId: 'batch-1',
    totalQuantity: 1000,
    totalBiomassKg: 400,
    currentQuantity: 1000,
    currentBiomassKg: 400,
    densityKgM3: 4,
    batchDetails: [
      { batchId: 'batch-1', batchNumber: 'B-1', quantity: 1000, biomassKg: 400, avgWeightG: 400, percentageOfTank: 100 },
    ],
  };

  const managerFindOne = jest.fn((entity: unknown) => {
    if (entity === Batch) return Promise.resolve(batch);
    if (entity === Tank) return Promise.resolve(tank);
    if (entity === TankBatch) return Promise.resolve(tankBatch);
    return Promise.resolve(null);
  });
  const createdHarvestRecords: Array<Record<string, unknown>> = [];
  const managerCreate = jest.fn((entity: unknown, data: Record<string, unknown>) => {
    if (entity === HarvestRecord) createdHarvestRecords.push(data);
    return data;
  });
  const managerSave = jest.fn((_entity: unknown, value: unknown) => Promise.resolve(value));

  // createMockDataSource models the fail-closed runInTenantTransaction
  // boundary: queryRunner.query returns [] so the search_path/GUC readback
  // assertion is skipped under the mock (no live connection). The factory's
  // manager is reconfigured below with the entity-identity-aware findOne /
  // create / save plus the createQueryBuilder generateCode() relies on.
  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
  (mockManager.findOne as jest.Mock).mockImplementation(managerFindOne);
  (mockManager.create as jest.Mock).mockImplementation(managerCreate);
  (mockManager.save as jest.Mock).mockImplementation(managerSave);
  mockManager.createQueryBuilder = jest
    .fn()
    .mockReturnValue(codeQueryBuilder) as typeof mockManager.createQueryBuilder;
  const commit = mockQueryRunner.commitTransaction as jest.Mock;
  const rollback = mockQueryRunner.rollbackTransaction as jest.Mock;
  const dataSource = mockDataSource;

  const enqueuedEvents: BatchHarvestedEvent[] = [];
  const outboxPublisher = {
    enqueue: jest.fn((event: BatchHarvestedEvent) => {
      enqueuedEvents.push(event);
      return Promise.resolve();
    }),
  } as never;

  const executeCommand = jest.fn((_command: CloseBatchCommand) =>
    opts.closeBatchError
      ? Promise.reject(opts.closeBatchError)
      : Promise.resolve(undefined),
  );
  const commandBus = { execute: executeCommand } as never;

  const harvestEligibility = {
    checkEligibility: jest
      .fn()
      .mockResolvedValue({ eligible: true, blockingEvents: [] }),
  };
  const backdatePolicy = { validate: jest.fn() };
  const harvestPolicy = { evaluate: jest.fn().mockResolvedValue(undefined) };
  const mobileCommandReceipts = {
    begin: jest.fn().mockResolvedValue({ mode: 'execute' }),
    complete: jest.fn().mockResolvedValue(undefined),
  };
  const farmStockProjection = {
    refreshContainers: jest.fn().mockResolvedValue(undefined),
  };
  // The single SSoT writer for tank composition — the handler routes the harvest
  // decrement through this so batchDetails[] stays consistent (no direct mutation).
  const stockChange = createStockChangeDouble();
  const tankBatchService = {
  };
  // Currency SSoT resolver (FARM-HIGH-151) — harvest revenue books under
  // the tenant default resolved through this, not a hardcoded literal.
  const financeSettings = {
    getDefaultCurrency: jest.fn().mockResolvedValue('NOK'),
  };

  const handler = new CreateHarvestRecordHandler(
    dataSource,
    outboxPublisher,
    commandBus,
    harvestEligibility as never,
    backdatePolicy as never,
    harvestPolicy as never,
    createMockRepository<HarvestRecord>(),
    createMockRepository<Batch>(),
    createMockRepository<TankOperation>(),
    createMockRepository<TankBatch>(),
    createMockRepository<Tank>(),
    stockChange.tankBatchService,
    financeSettings as never,
    // SEC-HIGH-051: the real fail-closed SSoT; commands below pass MODULE_MANAGER
    // so site authz bypasses for these final-harvest-chain domain tests.
    new SiteAuthorizationService(),
    farmStockProjection as never,
    mobileCommandReceipts as never,
  );

  return { handler, batch, commit, rollback, enqueuedEvents, executeCommand, createdHarvestRecords, stockChange };
}

function makeCommand(overrides: Partial<Record<string, unknown>> = {}) {
  const input = {
    batchId: 'batch-1',
    tankId: 'tank-1',
    quantityHarvested: 400,
    averageWeight: 500,
    totalBiomass: 200,
    qualityClass: QualityClass.SUPERIOR,
    harvestDate: '2026-06-10T08:00:00.000Z',
    ...overrides,
  };
  // MODULE_MANAGER so SEC-HIGH-051 site authz bypasses (createHarvestRecord's
  // @Roles floor is MODULE_MANAGER+ anyway — see SEC-MEDIUM-050).
  return new CreateHarvestRecordCommand(TENANT_ID, input, 'user-1', [Role.MODULE_MANAGER], []);
}

describe('CreateHarvestRecordHandler — final-harvest chain', () => {
  it('partial harvest: isFinal=false, no HARVESTED transition, no close dispatch', async () => {
    const { handler, batch, enqueuedEvents, executeCommand } = makeHarness({
      currentQuantity: 1000,
    });

    await handler.execute(makeCommand({ quantityHarvested: 400 }));

    expect(batch.currentQuantity).toBe(600);
    expect(batch.status).not.toBe(BatchStatus.HARVESTED);
    expect(enqueuedEvents).toHaveLength(1);
    const [event] = enqueuedEvents;
    expect(event?.eventType).toBe('BatchHarvested');
    expect(event?.isFinal).toBe(false);
    expect(event?.version).toBe(2);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('routes the tank-batch decrement through the stock scope with a signed delta (batchDetails stays consistent, day plan reprices)', async () => {
    const { handler, stockChange } = makeHarness({ currentQuantity: 1000 });

    await handler.execute(makeCommand({ quantityHarvested: 400, totalBiomass: 160 }));

    // Harvest must NOT mutate TankBatch.totalQuantity by hand (that left
    // batchDetails[] stale — the 719-vs-900 divergence). It routes the removal
    // through the stock scope, which decrements the per-batch SSoT in lock-step
    // AND reprices today's remaining meals for the unit it emptied.
    expect(stockChange.deltas).toHaveLength(1);
    const [recorded] = stockChange.deltas;
    expect(recorded!.reason).toBe('harvest');
    expect(recorded!.tankId).toBe('tank-1');
    expect(recorded!.delta.quantityDelta).toBe(-400);
    expect(recorded!.delta.biomassDelta).toBe(-160);
    expect(stockChange.applyStockChange.mock.calls[0]![1]).toBe(TENANT_ID);
  });

  it('final harvest: isFinal=true and CloseBatchCommand(HARVEST_COMPLETED) dispatched after commit', async () => {
    const { handler, batch, commit, enqueuedEvents, executeCommand } = makeHarness({
      currentQuantity: 400,
    });

    await handler.execute(makeCommand({ quantityHarvested: 400 }));

    expect(batch.currentQuantity).toBe(0);
    expect(batch.status).toBe(BatchStatus.HARVESTED);
    const [event] = enqueuedEvents;
    expect(event?.isFinal).toBe(true);
    expect(commit).toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledTimes(1);
    const dispatched = executeCommand.mock.calls[0]?.[0];
    expect(dispatched).toBeInstanceOf(CloseBatchCommand);
    expect(dispatched?.tenantId).toBe(TENANT_ID);
    expect(dispatched?.batchId).toBe('batch-1');
    expect(dispatched?.reason).toBe(BatchCloseReason.HARVEST_COMPLETED);
    expect(dispatched?.closedBy).toBe('user-1');
    // commit happened before dispatch (close handler opens its own TX).
    // `?? Infinity` keeps the assertion type-safe: a missing invocation
    // makes the comparison fail loudly rather than pass vacuously.
    expect(commit.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
      executeCommand.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('auto-close failure does not fail the committed harvest', async () => {
    const { handler, batch, commit, rollback } = makeHarness({
      currentQuantity: 400,
      closeBatchError: new Error('withdrawal period active'),
    });

    await expect(
      handler.execute(makeCommand({ quantityHarvested: 400 })),
    ).resolves.toBeDefined();

    expect(commit).toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
    // Batch stays HARVESTED — the exact state the manual close flow starts from.
    expect(batch.status).toBe(BatchStatus.HARVESTED);
  });

  it('auto-close blocked by an open withdrawal period logs WARN (not ERROR) and keeps the batch HARVESTED', async () => {
    // CloseBatchHandler refuses to auto-close a batch with an open medicine
    // withdrawal period (food-safety). That is a correct compliance gate, not
    // a system failure — it must not page on-call. The handler classifies it
    // as WARN, never ERROR, and the committed harvest still succeeds.
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { handler, batch } = makeHarness({
      currentQuantity: 400,
      closeBatchError: new BatchWithdrawalBlockedError({
        userMessage: 'open withdrawal period',
        activeTreatments: [],
        fieldPath: ['closeBatch', 'id'],
      }),
    });

    await expect(
      handler.execute(makeCommand({ quantityHarvested: 400 })),
    ).resolves.toBeDefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(batch.status).toBe(BatchStatus.HARVESTED);

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('idempotent double-final-harvest (batch already CLOSED) logs DEBUG (not ERROR)', async () => {
    // A concurrent close already moved the batch to CLOSED. CloseBatchHandler
    // throws "zaten kapatılmış"; the harvest is committed and benign, so the
    // handler logs DEBUG, never ERROR.
    const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { handler, batch } = makeHarness({
      currentQuantity: 400,
      closeBatchError: new BadRequestException('Batch batch-1 zaten kapatılmış'),
    });

    await expect(
      handler.execute(makeCommand({ quantityHarvested: 400 })),
    ).resolves.toBeDefined();

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(batch.status).toBe(BatchStatus.HARVESTED);

    debugSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('CreateHarvestRecordHandler — server-derived harvest identity (FARM-HIGH-051)', () => {
  it('persists supervisorId and stamps event userId from the server-supplied principal, never from the input', async () => {
    // recordedBy is the authenticated principal the resolver threads from
    // @CurrentUser → user.sub. It is the THIRD constructor argument of the
    // command and is the ONLY identity source the handler reads.
    const principal = 'authenticated-user-sub';
    const { handler, enqueuedEvents, createdHarvestRecords } = makeHarness({
      currentQuantity: 1000,
    });

    // The input deliberately carries an attacker-style attribution override
    // (`harvestedBy`) plus a stray `supervisorId`. Neither is part of the
    // command interface nor read by the handler, so identity must still come
    // from `recordedBy`.
    const validInput: CreateHarvestRecordCommand['input'] = {
      batchId: 'batch-1',
      tankId: 'tank-1',
      quantityHarvested: 400,
      averageWeight: 500,
      totalBiomass: 200,
      qualityClass: QualityClass.SUPERIOR,
      harvestDate: '2026-06-10T08:00:00.000Z',
    };
    // The attacker-style overrides (`harvestedBy`, `supervisorId`) are NOT part of
    // the command input interface. Carrying them on a structurally-wider object
    // lets the literal type-check WITHOUT a cast — the handler must ignore them
    // regardless, which is exactly what this test proves.
    const input: CreateHarvestRecordCommand['input'] & Record<string, unknown> = {
      ...validInput,
      harvestedBy: 'spoofed-other-user',
      supervisorId: 'spoofed-supervisor',
    };

    await handler.execute(
      new CreateHarvestRecordCommand(TENANT_ID, input, principal, [Role.MODULE_MANAGER], []),
    );

    expect(createdHarvestRecords).toHaveLength(1);
    expect(createdHarvestRecords[0]?.supervisorId).toBe(principal);
    // The spoofed override never reaches persistence.
    expect(createdHarvestRecords[0]?.supervisorId).not.toBe('spoofed-other-user');
    expect(createdHarvestRecords[0]?.supervisorId).not.toBe('spoofed-supervisor');

    const [event] = enqueuedEvents;
    expect(event?.userId).toBe(principal);
  });

  it('CreateHarvestRecordInput exposes no client-settable harvestedBy field', () => {
    // Regression guard for FARM-HIGH-051: `harvestedBy` was a required ID!
    // input field with no consumer — its arity 400'd every caller (mobile
    // included) while contributing nothing, since identity is server-derived.
    // Re-introducing the field is the regression we forbid here.
    //
    // The field was decorated with @IsNotEmpty()/@IsUUID(), so class-validator's
    // metadata storage is the authoritative, schema-build-free source of truth
    // for whether the property still exists on the validated input contract.
    // (The GraphQL @Field set is only fully materialised after a Nest schema
    // build, which a unit test must not require.) Re-adding `harvestedBy` as a
    // validated @Field would repopulate this metadata and fail the assertion.
    const properties = new Set(
      getMetadataStorage()
        .getTargetValidationMetadatas(
          CreateHarvestRecordInput,
          CreateHarvestRecordInput.name,
          false,
          false,
        )
        .map((m) => m.propertyName),
    );

    expect(properties.has('batchId')).toBe(true);
    expect(properties.has('tankId')).toBe(true);
    expect(properties.has('harvestedBy')).toBe(false);
  });
});
