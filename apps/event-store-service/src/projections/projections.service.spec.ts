import { SchedulerRegistry } from '@nestjs/schedule';
import { DataSource, Repository } from 'typeorm';
import { ProjectionsService } from './projections.service';
import {
  ProjectionCheckpoint,
  ProjectionStatus,
} from './entities/projection-checkpoint.entity';
import { StoredEvent } from '../event-store/entities/stored-event.entity';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PROJECTION_NAME = 'inventoryRollup';

function makeCheckpoint(
  overrides: Partial<ProjectionCheckpoint> = {},
): ProjectionCheckpoint {
  return {
    id: `checkpoint-${overrides.tenantId ?? TENANT_A}`,
    projectionName: PROJECTION_NAME,
    description: undefined,
    position: 0,
    status: ProjectionStatus.RUNNING,
    tenantId: TENANT_A,
    consumerGroup: undefined,
    eventTypes: [],
    aggregateTypes: [],
    eventsProcessed: 0,
    eventsFailed: 0,
    lastError: undefined,
    lastErrorAt: undefined,
    avgProcessingTimeMs: 0,
    createdAt: new Date('2026-05-30T00:00:00.000Z'),
    updatedAt: new Date('2026-05-30T00:00:00.000Z'),
    lastProcessedAt: undefined,
    ...overrides,
  };
}

function makeStoredEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id: 'event-1',
    streamName: `Order-33333333-3333-4333-8333-333333333333`,
    globalPosition: 1,
    streamPosition: 1,
    aggregateType: 'Order',
    aggregateId: '33333333-3333-4333-8333-333333333333',
    version: 1,
    eventType: 'OrderCreated',
    payload: {},
    metadata: undefined,
    tenantId: TENANT_A,
    correlationId: undefined,
    causationId: undefined,
    userId: undefined,
    occurredAt: new Date('2026-05-30T00:00:00.000Z'),
    storedAt: new Date('2026-05-30T00:00:01.000Z'),
    schemaVersion: 1,
    ...overrides,
  };
}

function createCheckpointRepository() {
  const checkpoints: ProjectionCheckpoint[] = [];

  return {
    checkpoints,
    repository: {
      findOne: jest.fn(async ({ where }: { where: Partial<ProjectionCheckpoint> }) =>
        checkpoints.find(
          (checkpoint) =>
            checkpoint.projectionName === where.projectionName &&
            checkpoint.tenantId === where.tenantId,
        ) ?? null,
      ),
      create: jest.fn((input: Partial<ProjectionCheckpoint>) =>
        makeCheckpoint(input),
      ),
      save: jest.fn(async (checkpoint: ProjectionCheckpoint) => {
        const existingIndex = checkpoints.findIndex(
          (row) =>
            row.projectionName === checkpoint.projectionName &&
            row.tenantId === checkpoint.tenantId,
        );
        if (existingIndex === -1) {
          checkpoints.push(checkpoint);
        } else {
          checkpoints[existingIndex] = checkpoint;
        }
        return checkpoint;
      }),
    } as unknown as jest.Mocked<Repository<ProjectionCheckpoint>>,
  };
}

function createSchedulerRegistry() {
  const intervals = new Set<string>();

  return {
    intervals,
    schedulerRegistry: {
      doesExist: jest.fn((_type: 'interval', name: string) =>
        intervals.has(name),
      ),
      addInterval: jest.fn((name: string) => {
        intervals.add(name);
      }),
      deleteInterval: jest.fn((name: string) => {
        intervals.delete(name);
      }),
    } as unknown as jest.Mocked<SchedulerRegistry>,
  };
}

function createQueryRunner() {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager: {
      update: jest.fn().mockResolvedValue(undefined),
    },
  };
}

describe('ProjectionsService tenant-scoped identity', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts the same projection name independently for two tenants', async () => {
    const { repository: checkpointRepository } = createCheckpointRepository();
    const { schedulerRegistry } = createSchedulerRegistry();
    const eventRepository = {
      createQueryBuilder: jest.fn(),
    } as unknown as Repository<StoredEvent>;
    const dataSource = {
      createQueryRunner: jest.fn(),
    } as unknown as DataSource;

    const service = new ProjectionsService(
      checkpointRepository,
      eventRepository,
      schedulerRegistry,
      dataSource,
    );

    await service.registerProjection(PROJECTION_NAME, jest.fn(), {
      tenantId: TENANT_A,
    });
    await service.registerProjection(PROJECTION_NAME, jest.fn(), {
      tenantId: TENANT_B,
    });

    await service.startProjection(PROJECTION_NAME, TENANT_A);
    await service.startProjection(PROJECTION_NAME, TENANT_B);

    expect(schedulerRegistry.addInterval).toHaveBeenCalledWith(
      `projection-${JSON.stringify([TENANT_A, PROJECTION_NAME])}`,
      expect.any(Object),
    );
    expect(schedulerRegistry.addInterval).toHaveBeenCalledWith(
      `projection-${JSON.stringify([TENANT_B, PROJECTION_NAME])}`,
      expect.any(Object),
    );
  });

  it('processes the handler registered for the requested tenant only', async () => {
    const { repository: checkpointRepository } = createCheckpointRepository();
    const queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest
        .fn()
        .mockResolvedValue([makeStoredEvent({ tenantId: TENANT_B })]),
    };
    const eventRepository = {
      createQueryBuilder: jest.fn(() => queryBuilder),
    } as unknown as Repository<StoredEvent>;
    const { schedulerRegistry } = createSchedulerRegistry();
    const queryRunner = createQueryRunner();
    const dataSource = {
      createQueryRunner: jest.fn(() => queryRunner),
    } as unknown as DataSource;

    const handlerA = jest.fn().mockResolvedValue(undefined);
    const handlerB = jest.fn().mockResolvedValue(undefined);
    const service = new ProjectionsService(
      checkpointRepository,
      eventRepository,
      schedulerRegistry,
      dataSource,
    );

    await service.registerProjection(PROJECTION_NAME, handlerA, {
      tenantId: TENANT_A,
    });
    await service.registerProjection(PROJECTION_NAME, handlerB, {
      tenantId: TENANT_B,
    });

    const result = await service.processBatch(PROJECTION_NAME, TENANT_B);

    expect(result).toEqual({ processed: 1, failed: 0, newPosition: 1 });
    expect(handlerA).not.toHaveBeenCalled();
    expect(handlerB).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_B }),
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'e.tenantId = :tenantId',
      { tenantId: TENANT_B },
    );
  });
});
