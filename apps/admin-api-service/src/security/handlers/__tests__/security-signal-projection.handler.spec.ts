/**
 * The sink for the security signal (ADMIN-HIGH-014, ADR-0018).
 *
 * `admin.login_attempts` and `admin.api_usage_logs` had readers and no writer.
 * Five anomaly detectors counted rows in them and every count was 0, so no
 * threshold was ever reachable — a security control that reported all-clear
 * because it could not see anything.
 */
import { Test } from '@nestjs/testing';
import type {
  AuthLoginFailedEvent,
  AuthLoginSuccessEvent,
  RateLimitExceededEvent,
} from '@platform/event-contracts';
import { SecurityEventType } from '@platform/event-contracts';

import { ActivityLoggingService } from '../../services/activity-logging.service';
import { SecurityMonitoringService } from '../../services/security-monitoring.service';
import { SecuritySignalProjectionHandler } from '../security-signal-projection.handler';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'operator@example.com';
const IP = '203.0.113.7';

interface Harness {
  handler: SecuritySignalProjectionHandler;
  activityLogging: { recordLoginAttempt: jest.Mock; logApiUsage: jest.Mock };
  monitoring: { analyzeLoginAttempt: jest.Mock; checkApiAbuse: jest.Mock };
  order: string[];
}

async function build(): Promise<Harness> {
  const order: string[] = [];
  const activityLogging = {
    // The writers report whether the row was actually stored: `null` / `false`
    // mean the source event was already projected and this is a redelivery.
    recordLoginAttempt: jest.fn(async () => {
      order.push('write');
      return { id: 'row-1' };
    }),
    logApiUsage: jest.fn(async () => {
      order.push('write');
      return true;
    }),
  };
  const monitoring = {
    analyzeLoginAttempt: jest.fn(async () => {
      order.push('analyze');
    }),
    checkApiAbuse: jest.fn(async () => {
      order.push('analyze');
    }),
  };
  const moduleRef = await Test.createTestingModule({
    // A PROVIDER: EventHandlerRegistryModule discovers @SubscribeTo over
    // getProviders(), so a controller registration would never be scanned.
    providers: [
      SecuritySignalProjectionHandler,
      { provide: ActivityLoggingService, useValue: activityLogging },
      { provide: SecurityMonitoringService, useValue: monitoring },
    ],
  }).compile();
  return {
    handler: moduleRef.get(SecuritySignalProjectionHandler),
    activityLogging,
    monitoring,
    order,
  };
}

function loginFailed(overrides: Partial<AuthLoginFailedEvent> = {}): AuthLoginFailedEvent {
  return {
    eventId: 'evt-1',
    eventType: 'AuthLoginFailed',
    securityEventType: SecurityEventType.AUTH_LOGIN_FAILED,
    tenantId: TENANT,
    timestamp: '2026-09-06T12:00:00.000Z',
    version: 1,
    userId: USER,
    email: EMAIL,
    ip: IP,
    reason: 'Invalid password (attempt 3)',
    failedAttempts: 3,
    ...overrides,
  } as AuthLoginFailedEvent;
}

function loginSucceeded(): AuthLoginSuccessEvent {
  const { reason: _reason, failedAttempts: _failedAttempts, ...common } = loginFailed();
  return {
    ...common,
    eventType: 'AuthLoginSuccess',
    securityEventType: SecurityEventType.AUTH_LOGIN_SUCCESS,
  };
}

describe('SecuritySignalProjectionHandler', () => {
  it('writes the login row, so the detectors stop counting an empty table', async () => {
    const { handler, activityLogging } = await build();

    await handler.onLoginFailed(loginFailed());

    expect(activityLogging.recordLoginAttempt).toHaveBeenCalledTimes(1);
    expect(activityLogging.recordLoginAttempt.mock.calls[0][0]).toMatchObject({
      email: EMAIL,
      ipAddress: IP,
      success: false,
      userId: USER,
      tenantId: TENANT,
      failureReason: 'Invalid password (attempt 3)',
    });
  });

  it('writes the row BEFORE analysing, or every threshold is off by one', async () => {
    // The detectors count rows including this attempt. Analysing first would
    // make the fifth failed login look like the fourth.
    const { handler, order } = await build();

    await handler.onLoginFailed(loginFailed());

    expect(order).toEqual(['write', 'analyze']);
  });

  it('runs detection on every real attempt, not when an operator presses a button', async () => {
    const { handler, monitoring } = await build();

    await handler.onLoginFailed(loginFailed());

    expect(monitoring.analyzeLoginAttempt).toHaveBeenCalledTimes(1);
    expect(monitoring.analyzeLoginAttempt.mock.calls[0][0]).toMatchObject({
      email: EMAIL,
      ipAddress: IP,
      success: false,
    });
  });

  it('projects a successful login too — the geo baseline is built from successes', async () => {
    const { handler, activityLogging } = await build();

    await handler.onLoginSuccess(loginSucceeded());

    expect(activityLogging.recordLoginAttempt.mock.calls[0][0]).toMatchObject({
      success: true,
      failureReason: undefined,
    });
  });

  it("treats the wire's 'system' tenant as absent, not as a tenant id", async () => {
    const { handler, activityLogging } = await build();

    await handler.onLoginFailed(loginFailed({ tenantId: 'system' }));

    expect(activityLogging.recordLoginAttempt.mock.calls[0][0].tenantId).toBeUndefined();
  });

  it('skips a signal with no email rather than writing a row no query can find', async () => {
    const { handler, activityLogging, monitoring } = await build();

    await handler.onLoginFailed(loginFailed({ email: undefined }));

    expect(activityLogging.recordLoginAttempt).not.toHaveBeenCalled();
    expect(monitoring.analyzeLoginAttempt).not.toHaveBeenCalled();
  });

  it('re-raises a projection failure so JetStream redelivers instead of losing the fact', async () => {
    // The previous version swallowed it. Under a durable consumer that means a
    // transient database blip permanently drops a failed-login row, and the
    // fifth attempt in a burst looks like the fourth. Re-raising NAKs the
    // message; the retry is safe because the write is idempotent on eventId.
    const { handler, activityLogging } = await build();
    activityLogging.recordLoginAttempt.mockRejectedValue(new Error('db down'));

    await expect(handler.onLoginFailed(loginFailed())).rejects.toThrow('db down');
  });

  it('carries the source event id, which is what makes the retry safe', async () => {
    const { handler, activityLogging } = await build();

    await handler.onLoginFailed(loginFailed());

    expect(activityLogging.recordLoginAttempt.mock.calls[0][0].sourceEventId).toBe('evt-1');
  });

  it('does not re-run the detectors when a redelivery finds the row already stored', async () => {
    // Counting the same failed login twice manufactures a brute_force_attempt.
    const { handler, activityLogging, monitoring } = await build();
    activityLogging.recordLoginAttempt.mockResolvedValue(null);

    await handler.onLoginFailed(loginFailed());

    expect(monitoring.analyzeLoginAttempt).not.toHaveBeenCalled();
  });

  it('does not re-run checkApiAbuse on a redelivered rate-limit signal', async () => {
    const { handler, activityLogging, monitoring } = await build();
    activityLogging.logApiUsage.mockResolvedValue(false);

    await handler.onRateLimitExceeded({
      eventId: 'evt-2',
      eventType: 'RateLimitExceeded',
      securityEventType: SecurityEventType.RATE_LIMIT_EXCEEDED,
      tenantId: TENANT,
      timestamp: '2026-09-06T12:00:00.000Z',
      version: 1,
      ip: IP,
      key: 'login:203.0.113.7',
      limit: 20,
      windowMs: 60_000,
      count: 21,
    } as RateLimitExceededEvent);

    expect(monitoring.checkApiAbuse).not.toHaveBeenCalled();
  });

  it('projects a rate-limit rejection as the API-abuse fact checkApiAbuse counts', async () => {
    const { handler, activityLogging, monitoring, order } = await build();

    await handler.onRateLimitExceeded({
      eventId: 'evt-2',
      eventType: 'RateLimitExceeded',
      securityEventType: SecurityEventType.RATE_LIMIT_EXCEEDED,
      tenantId: TENANT,
      timestamp: '2026-09-06T12:00:00.000Z',
      version: 1,
      ip: IP,
      key: 'login:203.0.113.7',
      limit: 20,
      windowMs: 60_000,
      count: 21,
    } as RateLimitExceededEvent);

    expect(activityLogging.logApiUsage.mock.calls[0][0]).toMatchObject({
      statusCode: 429,
      rateLimitExceeded: true,
      endpoint: 'login:203.0.113.7',
    });
    expect(monitoring.checkApiAbuse).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['write', 'analyze']);
  });
});
