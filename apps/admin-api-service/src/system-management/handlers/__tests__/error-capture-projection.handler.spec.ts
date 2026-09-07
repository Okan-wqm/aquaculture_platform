/**
 * The error store finally has a producer (ADMIN-HIGH-014, OBS-CRITICAL-003).
 *
 * `admin.error_groups` and `admin.error_occurrences` had a page, a dashboard,
 * four read endpoints and a 1,000-line service, and nothing had ever written a
 * row: the only entry point was a `security-ops`-gated POST that a crashing
 * service cannot authenticate to.
 */
import { Test } from '@nestjs/testing';
import type { ServiceErrorCapturedEvent } from '@platform/event-contracts';

import { ErrorSeverity } from '../../entities/error-tracking.entity';
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

  it("treats the wire's empty tenant as absent — the column is uuid, not text", async () => {
    // A platform-level failure belongs to no tenant and travels with '' so the
    // bus derives the events.system.* subject. '' is not a uuid.
    const { handler, errorTracking } = await build();

    await handler.onServiceErrorCaptured(captured({ tenantId: '' }));

    expect(errorTracking.reportError.mock.calls[0][0].tenantId).toBeUndefined();
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

    await expect(handler.onServiceErrorCaptured(captured())).resolves.toBeUndefined();
  });
});
