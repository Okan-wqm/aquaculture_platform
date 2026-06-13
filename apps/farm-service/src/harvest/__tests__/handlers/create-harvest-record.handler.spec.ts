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
import { createMockRepository } from '@aquaculture/testing';
import type { BatchHarvestedEvent } from '@platform/event-contracts';
import type { QueryRunner } from 'typeorm';

import { CloseBatchCommand, BatchCloseReason } from '../../../batch/commands/close-batch.command';
import { Batch, BatchStatus } from '../../../batch/entities/batch.entity';
import { TankBatch } from '../../../batch/entities/tank-batch.entity';
import { TankOperation } from '../../../batch/entities/tank-operation.entity';
import { BatchWithdrawalBlockedError } from '../../../common/errors/farm-errors';
import { Tank } from '../../../tank/entities/tank.entity';
import { CreateHarvestRecordCommand } from '../../commands/create-harvest-record.command';
import { HarvestRecord, QualityGrade } from '../../entities/harvest-record.entity';
import { CreateHarvestRecordHandler } from '../../handlers/create-harvest-record.handler';

interface HarnessOpts {
  /** Fish currently in the batch (default 1000). */
  currentQuantity?: number;
  /** Reject the auto-close dispatch. */
  closeBatchError?: Error;
}

function makeHarness(opts: HarnessOpts = {}) {
  const batch = {
    id: 'batch-1',
    tenantId: 'tenant-1',
    currentQuantity: opts.currentQuantity ?? 1000,
    harvestedQuantity: 0,
    status: BatchStatus.HARVESTING,
    isActive: true,
    getRetentionRate: jest.fn().mockReturnValue(95),
  };

  const tank = {
    id: 'tank-1',
    tenantId: 'tenant-1',
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
  };

  const managerFindOne = jest.fn((entity: unknown) => {
    if (entity === Batch) return Promise.resolve(batch);
    if (entity === Tank) return Promise.resolve(tank);
    return Promise.resolve(null);
  });
  const managerCreate = jest.fn((_entity: unknown, data: Record<string, unknown>) => data);
  const managerSave = jest.fn((_entity: unknown, value: unknown) => Promise.resolve(value));

  const manager = {
    findOne: managerFindOne,
    create: managerCreate,
    save: managerSave,
    createQueryBuilder: jest.fn().mockReturnValue(codeQueryBuilder),
  } as never;

  const commit = jest.fn().mockResolvedValue(undefined);
  const rollback = jest.fn().mockResolvedValue(undefined);
  const queryRunner: Partial<QueryRunner> = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: commit,
    rollbackTransaction: rollback,
    release: jest.fn().mockResolvedValue(undefined),
    manager,
  };
  const dataSource = {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  } as never;

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
    farmStockProjection as never,
    mobileCommandReceipts as never,
  );

  return { handler, batch, commit, rollback, enqueuedEvents, executeCommand };
}

function makeCommand(overrides: Partial<Record<string, unknown>> = {}) {
  const input = {
    batchId: 'batch-1',
    tankId: 'tank-1',
    quantityHarvested: 400,
    averageWeight: 500,
    totalBiomass: 200,
    qualityGrade: QualityGrade.GRADE_A,
    harvestDate: '2026-06-10T08:00:00.000Z',
    ...overrides,
  };
  return new CreateHarvestRecordCommand('tenant-1', input, 'user-1');
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
    expect(dispatched?.tenantId).toBe('tenant-1');
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

  it('rejects an unknown quality grade instead of silently upgrading to GRADE_A', async () => {
    const { handler, enqueuedEvents } = makeHarness();

    await expect(
      handler.execute(makeCommand({ qualityGrade: 'NOT_A_GRADE' })),
    ).rejects.toThrow(BadRequestException);

    expect(enqueuedEvents).toHaveLength(0);
  });
});
