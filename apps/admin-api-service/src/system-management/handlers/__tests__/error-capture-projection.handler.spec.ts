/**
 * The error store finally has a producer (ADMIN-HIGH-014, OBS-CRITICAL-003).
 *
 * `admin.error_groups` and `admin.error_occurrences` had a page, a dashboard,
 * four read endpoints and a 1,000-line service, and nothing had ever written a
 * row: the only entry point was a `security-ops`-gated POST that a crashing
 * service cannot authenticate to.
 */
import {
  ScheduledJobRunner,
  type ScheduledJobExecutor,
} from '@aquaculture/backend-common/scheduling';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  PLATFORM_EVENT_TENANT_ID,
  type ServiceErrorCapturedEvent,
} from '@platform/event-contracts';

import {
  ErrorAlertRule,
  ErrorGroup,
  ErrorOccurrence,
  ErrorSeverity,
} from '../../entities/error-tracking.entity';
import { ErrorTrackingService } from '../../services/error-tracking.service';
import { ErrorCaptureProjectionHandler } from '../error-capture-projection.handler';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';

interface Harness {
  handler: ErrorCaptureProjectionHandler;
  errorTracking: { reportError: jest.Mock };
}

async function build(): Promise<Harness> {
  const errorTracking = { reportError: jest.fn().mockResolvedValue({ id: 'occ-1' }) };
  const moduleRef = await Test.createTestingModule({
    providers: [
      ErrorCaptureProjectionHandler,
      { provide: ErrorTrackingService, useValue: errorTracking },
    ],
  }).compile();
  return { handler: moduleRef.get(ErrorCaptureProjectionHandler), errorTracking };
}

function captured(overrides: Partial<ServiceErrorCapturedEvent> = {}): ServiceErrorCapturedEvent {
  return {
    eventId: 'evt-1',
    eventType: 'ServiceErrorCaptured',
    timestamp: '2026-09-07T06:00:00.000Z',
    tenantId: TENANT,
    version: 1,
    aggregateId: 'farm-service',
    aggregateType: 'Service',
    message: 'database is unreachable',
    errorType: 'QueryFailedError',
    stackTrace: 'QueryFailedError: database is unreachable\n    at Pool.query',
    service: 'farm-service',
    environment: 'production',
    severity: 'error',
    statusCode: 500,
    transport: 'http',
    httpMethod: 'GET',
    httpRoute: '/api/tenants/:id/farms',
    userId: USER,
    ...overrides,
  } as ServiceErrorCapturedEvent;
}

describe('ErrorCaptureProjectionHandler', () => {
  it('writes the error the stream carried, so the page stops showing nothing', async () => {
    const { handler, errorTracking } = await build();

    await handler.onServiceErrorCaptured(captured());

    expect(errorTracking.reportError).toHaveBeenCalledTimes(1);
    expect(errorTracking.reportError.mock.calls[0][0]).toMatchObject({
      message: 'database is unreachable',
      errorType: 'QueryFailedError',
      service: 'farm-service',
      environment: 'production',
      severity: ErrorSeverity.ERROR,
      tenantId: TENANT,
      userId: USER,
    });
  });

  it('maps a non-HttpException capture to CRITICAL', async () => {
    const { handler, errorTracking } = await build();

    await handler.onServiceErrorCaptured(captured({ severity: 'critical', statusCode: 0 }));

    expect(errorTracking.reportError.mock.calls[0][0].severity).toBe(ErrorSeverity.CRITICAL);
  });

  it('stores a platform-level failure with no tenant — the column is uuid, not text', async () => {
    // OBS-HIGH-009: a tenant-less failure carries the contract's one platform
    // segment, the same one the bus routes events.system.* on.
    const { handler, errorTracking } = await build();

    await handler.onServiceErrorCaptured(captured({ tenantId: PLATFORM_EVENT_TENANT_ID }));

    expect(errorTracking.reportError).toHaveBeenCalledTimes(1);
    expect(errorTracking.reportError.mock.calls[0][0].tenantId).toBeUndefined();
  });

  it("refuses '' rather than reading a second platform spelling as no tenant", async () => {
    // '' was the interceptor's private sentinel; the bus refused every one of
    // them. Parsing through the contract keeps it from ever becoming a row.
    const { handler, errorTracking } = await build();

    await expect(handler.onServiceErrorCaptured(captured({ tenantId: '' }))).resolves.toEqual({
      kind: 'ack',
      reason: expect.stringMatching(/tenantId must be a UUID or the platform segment "system"/),
    });
    expect(errorTracking.reportError).not.toHaveBeenCalled();
  });

  it('drops a userId that is not a uuid rather than failing the insert', async () => {
    const { handler, errorTracking } = await build();

    await handler.onServiceErrorCaptured(captured({ userId: 'service-account' }));

    expect(errorTracking.reportError.mock.calls[0][0].userId).toBeUndefined();
  });

  it('carries the route and status into the context an operator reads', async () => {
    const { handler, errorTracking } = await build();

    await handler.onServiceErrorCaptured(captured());

    expect(errorTracking.reportError.mock.calls[0][0].context).toMatchObject({
      request: { method: 'GET', url: '/api/tenants/:id/farms' },
      response: { statusCode: 500 },
      tags: { transport: 'http' },
    });
  });

  it('acks a projection failure instead of NAKing it back into the incident', async () => {
    // The sibling security projection re-raises, because a lost failed-login is
    // a detection gap. This stream is redundant — Prometheus counted the 5xx and
    // the same defect recurs in seconds — so NAKing would only redeliver
    // database writes during a database-caused error storm.
    const { handler, errorTracking } = await build();
    errorTracking.reportError.mockRejectedValue(new Error('db down'));

    // The ack carries the reason, so a disposition an operator has to explain
    // is never indistinguishable from a message the handler simply swallowed.
    await expect(handler.onServiceErrorCaptured(captured())).resolves.toEqual({
      kind: 'ack',
      reason: 'projection failed: db down',
    });
  });
});

/**
 * OBS-HIGH-009, end to end inside admin-api: a platform-level capture folds
 * into an `admin.error_groups` row through the REAL ErrorTrackingService; only
 * the repositories are doubles. Production had 0 rows.
 */
describe('ErrorCaptureProjectionHandler → admin.error_groups (OBS-HIGH-009)', () => {
  const GROUP_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  const passThroughScheduledJobs: ScheduledJobExecutor = {
    run: async (_job, body) => {
      await body();
      return 'ran';
    },
  };

  it('writes a platform-level failure as a group with no affected tenant', async () => {
    const groupRepo = {
      query: jest.fn().mockResolvedValue([{ id: GROUP_ID, inserted: true }]),
      findOneBy: jest.fn().mockResolvedValue({ id: GROUP_ID, occurrenceCount: 1 }),
    };
    const occurrenceRepo = {
      create: jest.fn((entity: Partial<ErrorOccurrence>) => entity),
      save: jest.fn((entity: Partial<ErrorOccurrence>) => Promise.resolve(entity)),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ErrorCaptureProjectionHandler,
        ErrorTrackingService,
        { provide: ScheduledJobRunner, useValue: passThroughScheduledJobs },
        { provide: getRepositoryToken(ErrorGroup), useValue: groupRepo },
        { provide: getRepositoryToken(ErrorOccurrence), useValue: occurrenceRepo },
        {
          provide: getRepositoryToken(ErrorAlertRule),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
      ],
    }).compile();
    const handler = moduleRef.get(ErrorCaptureProjectionHandler);

    await expect(
      handler.onServiceErrorCaptured(captured({ tenantId: PLATFORM_EVENT_TENANT_ID })),
    ).resolves.toEqual({ kind: 'ack' });

    expect(groupRepo.query).toHaveBeenCalledTimes(1);
    const [sql, params] = groupRepo.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO "admin"."error_groups"');
    // $8 is the affected tenant: NULL keeps affectedTenants '[]'.
    expect(params[7]).toBeNull();
    expect(occurrenceRepo.save).toHaveBeenCalledTimes(1);
    expect(occurrenceRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: GROUP_ID, service: 'farm-service', tenantId: undefined }),
    );
  });
});
