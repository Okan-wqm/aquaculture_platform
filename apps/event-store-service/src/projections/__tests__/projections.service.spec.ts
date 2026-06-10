import { NotFoundException } from '@nestjs/common';
import { ProjectionsService } from '../projections.service';
import {
  ProjectionCheckpoint,
  ProjectionStatus,
} from '../entities/projection-checkpoint.entity';
import { StoredEvent } from '../../event-store/entities/stored-event.entity';
import {
  EventHandler,
  PersistedEvent,
} from '../../event-store/interfaces/event-store.interfaces';

const tenantA = '123e4567-e89b-42d3-a456-426614174000';
const tenantB = '223e4567-e89b-42d3-a456-426614174000';
const tenantC = '323e4567-e89b-42d3-a456-426614174000';
const projectionName = 'farm-summary';

function checkpointKey(tenantId: string, name = projectionName): string {
  return `${tenantId}:${name}`;
}

function makeCheckpoint(
  overrides: Partial<ProjectionCheckpoint> = {},
): ProjectionCheckpoint {
  const tenantId = overrides.tenantId ?? tenantA;
  const projection = overrides.projectionName ?? projectionName;

  return {
    id: `${tenantId}-${projection}`,
    projectionName: projection,
    description: undefined,
    position: 0,
    status: ProjectionStatus.RUNNING,
    tenantId,
    consumerGroup: undefined,
    eventTypes: [],
    aggregateTypes: [],
    eventsProcessed: 0,
    eventsFailed: 0,
    lastError: undefined,
    lastErrorAt: undefined,
    avgProcessingTimeMs: 0,
    createdAt: new Date('2026-05-30T00:00:00Z'),
    updatedAt: new Date('2026-05-30T00:00:00Z'),
    lastProcessedAt: undefined,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  const tenantId = overrides.tenantId ?? tenantA;

  return {
    id: `${tenantId}-event-${overrides.globalPosition ?? 1}`,
    streamName: 'Farm-123e4567-e89b-42d3-a456-426614174000',
    globalPosition: 1,
    streamPosition: 1,
    aggregateType: 'Farm',
    aggregateId: '123e4567-e89b-42d3-a456-426614174000',
    version: 1,
    eventType: 'FarmCreated',
    payload: {},
    metadata: undefined,
    tenantId,
    correlationId: undefined,
    causationId: undefined,
    userId: undefined,
    occurredAt: new Date('2026-05-30T00:00:00Z'),
    storedAt: new Date('2026-05-30T00:00:00Z'),
    schemaVersion: 1,
    ...overrides,
  };
}

function makeHandler(): jest.MockedFunction<EventHandler> {
  return jest.fn<ReturnType<EventHandler>, Parameters<EventHandler>>().mockResolvedValue();
}

describe('ProjectionsService tenant projection identity', () => {
  let service: ProjectionsService;
  let checkpoints: Map<string, ProjectionCheckpoint>;
  let eventBatches: StoredEvent[][];
  let queryBuilders: Array<Record<string, jest.Mock>>;
  let intervals: Map<string, NodeJS.Timeout>;
  let checkpointRepository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
  };
  let eventRepository: {
    createQueryBuilder: jest.Mock;
  };
  let schedulerRegistry: {
    doesExist: jest.Mock;
    addInterval: jest.Mock;
    deleteInterval: jest.Mock;
  };
  let dataSource: {
    createQueryRunner: jest.Mock;
  };

  beforeEach(() => {
    jest.useFakeTimers();

    checkpoints = new Map();
    eventBatches = [];
    queryBuilders = [];
    intervals = new Map();

    checkpointRepository = {
      findOne: jest.fn(async ({ where }: { where: { tenantId: string; projectionName: string } }) =>
        checkpoints.get(checkpointKey(where.tenantId, where.projectionName)) ?? null,
      ),
      create: jest.fn((input: Partial<ProjectionCheckpoint>) => makeCheckpoint(input)),
      save: jest.fn(async (checkpoint: ProjectionCheckpoint) => {
        checkpoints.set(
          checkpointKey(checkpoint.tenantId, checkpoint.projectionName),
          checkpoint,
        );
        return checkpoint;
      }),
      find: jest.fn(async ({ where }: { where: { tenantId: string } }) =>
        [...checkpoints.values()].filter((checkpoint) => checkpoint.tenantId === where.tenantId),
      ),
    };

    eventRepository = {
      createQueryBuilder: jest.fn(() => {
        const queryBuilder: Record<string, jest.Mock> = {
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          take: jest.fn().mockReturnThis(),
          getMany: jest.fn(async () => eventBatches.shift() ?? []),
          getRawOne: jest.fn(async () => ({ maxPosition: '0' })),
        };

        queryBuilders.push(queryBuilder);
        return queryBuilder;
      }),
    };

    schedulerRegistry = {
      doesExist: jest.fn((_type: string, name: string) => intervals.has(name)),
      addInterval: jest.fn((name: string, timeout: NodeJS.Timeout) => {
        intervals.set(name, timeout);
      }),
      deleteInterval: jest.fn((name: string) => {
        const timeout = intervals.get(name);
        if (timeout) {
          clearTimeout(timeout);
        }
        intervals.delete(name);
      }),
    };

    dataSource = {
      createQueryRunner: jest.fn(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockResolvedValue(undefined),
        commitTransaction: jest.fn().mockResolvedValue(undefined),
        rollbackTransaction: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        manager: {
          update: jest.fn().mockResolvedValue(undefined),
        },
      })),
    };

    service = new ProjectionsService(
      checkpointRepository as never,
      eventRepository as never,
      schedulerRegistry as never,
      dataSource as never,
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  async function registerTwoTenants(
    handlerA = makeHandler(),
    handlerB = makeHandler(),
  ): Promise<{ handlerA: jest.MockedFunction<EventHandler>; handlerB: jest.MockedFunction<EventHandler> }> {
    await service.registerProjection(projectionName, handlerA, { tenantId: tenantA });
    await service.registerProjection(projectionName, handlerB, { tenantId: tenantB });
    return { handlerA, handlerB };
  }

  it('dispatches processBatch through the tenant-qualified registered projection', async () => {
    const { handlerA, handlerB } = await registerTwoTenants();

    eventBatches.push(
      [makeEvent({ tenantId: tenantA, globalPosition: 10 })],
      [makeEvent({ tenantId: tenantB, globalPosition: 20 })],
    );

    await expect(service.processBatch(projectionName, tenantA)).resolves.toEqual({
      processed: 1,
      failed: 0,
      newPosition: 10,
    });
    await expect(service.processBatch(projectionName, tenantB)).resolves.toEqual({
      processed: 1,
      failed: 0,
      newPosition: 20,
    });

    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect((handlerA.mock.calls[0]![0] as PersistedEvent).tenantId).toBe(tenantA);
    expect((handlerB.mock.calls[0]![0] as PersistedEvent).tenantId).toBe(tenantB);

    const firstQuery = queryBuilders[0]!;
    const secondQuery = queryBuilders[1]!;
    expect(firstQuery.andWhere).toHaveBeenCalledWith('e.tenantId = :tenantId', {
      tenantId: tenantA,
    });
    expect(secondQuery.andWhere).toHaveBeenCalledWith('e.tenantId = :tenantId', {
      tenantId: tenantB,
    });
  });

  it('uses tenant-scoped locks for the same projection name', async () => {
    await registerTwoTenants();

    const serviceInternals = service as unknown as {
      getProjectionKey: (tenantId: string, name: string) => string;
      processingLocks: Map<string, boolean>;
    };
    serviceInternals.processingLocks.set(
      serviceInternals.getProjectionKey(tenantA, projectionName),
      true,
    );

    eventBatches.push([makeEvent({ tenantId: tenantB, globalPosition: 2 })]);

    await expect(service.processBatch(projectionName, tenantA)).resolves.toEqual({
      processed: 0,
      failed: 0,
      newPosition: 0,
    });
    await expect(service.processBatch(projectionName, tenantB)).resolves.toMatchObject({
      processed: 1,
      failed: 0,
      newPosition: 2,
    });
  });

  it('starts and stops tenant-specific processing intervals without colliding', async () => {
    await registerTwoTenants();

    await service.startProjection(projectionName, tenantA);
    await service.startProjection(projectionName, tenantB);

    expect(intervals.size).toBe(2);
    const intervalNames = [...intervals.keys()];
    expect(intervalNames[0]).not.toBe(intervalNames[1]);
    expect(intervalNames.some((name) => name.includes(tenantA))).toBe(true);
    expect(intervalNames.some((name) => name.includes(tenantB))).toBe(true);

    await expect(service.startProjection(projectionName, tenantC)).rejects.toThrow(
      NotFoundException,
    );

    await service.stopProjection(projectionName, tenantA);

    expect(intervals.size).toBe(1);
    expect([...intervals.keys()][0]).toContain(tenantB);
    expect(schedulerRegistry.deleteInterval).toHaveBeenCalledWith(
      expect.stringContaining(tenantA),
    );
  });

  it('pauses, resumes, and resets only the requested tenant registration cache', async () => {
    await registerTwoTenants();

    eventBatches.push([], []);
    await service.processBatch(projectionName, tenantA);
    await service.processBatch(projectionName, tenantB);

    const serviceInternals = service as unknown as {
      getProjectionKey: (tenantId: string, name: string) => string;
      registeredProjections: Map<
        string,
        { cachedCheckpoint?: ProjectionCheckpoint; idleBatchCount: number }
      >;
    };
    const keyA = serviceInternals.getProjectionKey(tenantA, projectionName);
    const keyB = serviceInternals.getProjectionKey(tenantB, projectionName);

    expect(serviceInternals.registeredProjections.get(keyA)?.cachedCheckpoint).toBeDefined();
    expect(serviceInternals.registeredProjections.get(keyB)?.cachedCheckpoint).toBeDefined();

    await service.pauseProjection(projectionName, tenantA);

    expect(checkpoints.get(checkpointKey(tenantA))?.status).toBe(ProjectionStatus.PAUSED);
    expect(checkpoints.get(checkpointKey(tenantB))?.status).toBe(ProjectionStatus.RUNNING);
    expect(serviceInternals.registeredProjections.get(keyA)?.cachedCheckpoint).toBeUndefined();
    expect(serviceInternals.registeredProjections.get(keyB)?.cachedCheckpoint).toBeDefined();

    await service.resumeProjection(projectionName, tenantA);

    expect(checkpoints.get(checkpointKey(tenantA))?.status).toBe(ProjectionStatus.RUNNING);

    eventBatches.push([]);
    await service.processBatch(projectionName, tenantA);
    expect(serviceInternals.registeredProjections.get(keyA)?.cachedCheckpoint).toBeDefined();

    await service.resetProjection(projectionName, 42, tenantA);

    expect(checkpoints.get(checkpointKey(tenantA))?.position).toBe(42);
    expect(checkpoints.get(checkpointKey(tenantB))?.position).toBe(0);
    expect(serviceInternals.registeredProjections.get(keyA)?.cachedCheckpoint).toBeUndefined();
    expect(serviceInternals.registeredProjections.get(keyB)?.cachedCheckpoint).toBeDefined();
  });

  it('resolves registered tenants by canonical tenant/name key', async () => {
    await registerTwoTenants();

    const serviceInternals = service as unknown as {
      getProjectionKey: (tenantId: string, name: string) => string;
      getProjectionTenantId: (projectionKey: string) => string;
    };

    expect(
      serviceInternals.getProjectionTenantId(
        serviceInternals.getProjectionKey(tenantA, projectionName),
      ),
    ).toBe(tenantA);
    expect(
      serviceInternals.getProjectionTenantId(
        serviceInternals.getProjectionKey(tenantB, projectionName),
      ),
    ).toBe(tenantB);
  });
});
