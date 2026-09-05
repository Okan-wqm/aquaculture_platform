import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { InvalidEventTenantScopeError } from '@platform/event-contracts';
import type { UserAccountLockedEvent } from '@platform/event-contracts';

import { AuthEventHandler } from './auth-event.handler';
import { EmailDeliveryError, EmailService } from '../services/email.service';

import { signedFetchJson } from '@aquaculture/backend-common/http';

jest.mock('@aquaculture/backend-common/http', () => ({
  signedFetchJson: jest.fn(),
}));

/**
 * ORPHAN-MEDIUM-320 — the account-locked owner notification.
 *
 * The login wire response stays the generic anti-enumeration message, so
 * this email is the ONLY owner-facing lockout signal. These tests pin:
 * PII resolved at delivery time (never from the bus), the unlock instant
 * and reset guidance in the body, and fail-closed skips on malformed
 * events or unresolvable PII.
 */
describe('AuthEventHandler — UserAccountLocked (ORPHAN-MEDIUM-320)', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const mockSignedFetch = signedFetchJson as jest.MockedFunction<typeof signedFetchJson>;

  const emailService = {
    sendEmail: jest.fn().mockResolvedValue('message-id-1'),
  };
  const eventBus = {
    subscribeWildcard: jest.fn().mockResolvedValue(undefined),
  };
  // Cast-free construction: Nest DI accepts structural doubles via useValue,
  // so the handler gets its collaborators without any type assertion.
  let handler: AuthEventHandler;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthEventHandler,
        { provide: EmailService, useValue: emailService },
        { provide: 'EVENT_BUS', useValue: eventBus },
        { provide: ConfigService, useValue: new ConfigService({}) },
      ],
    }).compile();
    handler = moduleRef.get(AuthEventHandler);
  });

  const lockEvent = (overrides: Partial<UserAccountLockedEvent> = {}): UserAccountLockedEvent =>
    ({
      eventId: 'event-1',
      eventType: 'UserAccountLocked',
      timestamp: new Date().toISOString(),
      tenantId: TENANT,
      version: 1,
      aggregateId: 'user-1',
      aggregateType: 'User',
      userId: 'user-1',
      failedAttempts: 5,
      lockedUntil: '2026-07-02T12:29:52.000Z',
      ...overrides,
    }) as UserAccountLockedEvent;

  beforeEach(() => {
    jest.clearAllMocks();
    emailService.sendEmail.mockResolvedValue('message-id-1');
  });

  it('subscribes to UserAccountLocked on module init', async () => {
    await handler.onModuleInit();
    expect(eventBus.subscribeWildcard).toHaveBeenCalledWith('UserAccountLocked', handler);
  });

  it('resolves PII at delivery time and emails the unlock instant + reset guidance', async () => {
    mockSignedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: { email: 'owner@example.test', firstName: 'Okan' },
    });

    await expect(handler.handle(lockEvent())).resolves.toEqual({ kind: 'ack' });

    // PII endpoint, not the event bus, is the address source.
    expect(mockSignedFetch).toHaveBeenCalledWith(
      expect.stringContaining('/internal/users/user-1/pii'),
      expect.objectContaining({ tenantId: TENANT, audience: 'auth-service' }),
    );
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const [to, subject, html] = emailService.sendEmail.mock.calls[0] as [string, string, string];
    expect(to).toBe('owner@example.test');
    expect(subject).toContain('locked');
    expect(html).toContain('5 failed sign-in attempts');
    expect(html).toContain(new Date('2026-07-02T12:29:52.000Z').toUTCString());
    expect(html).toContain('resetting your password');
  });

  it('asks for a retry when auth-service is unavailable (503), sending nothing', async () => {
    mockSignedFetch.mockResolvedValue({
      ok: false,
      status: 503,
      failureClass: 'transient',
      error: 'HTTP 503',
    });

    await expect(handler.handle(lockEvent())).resolves.toEqual(
      expect.objectContaining({ kind: 'retry' }),
    );
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  it('terminates when the principal does not exist for this scope (404): redelivery cannot fix it', async () => {
    mockSignedFetch.mockResolvedValue({
      ok: false,
      status: 404,
      failureClass: 'permanent',
      error: 'HTTP 404',
    });

    await expect(handler.handle(lockEvent())).resolves.toEqual(
      expect.objectContaining({ kind: 'terminate' }),
    );
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  it('SEC-HIGH-057: a platform-scoped lockout (super admin) resolves PII through the platform-scope identity', async () => {
    mockSignedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: { email: 'root@example.test', firstName: 'Root' },
    });

    await expect(handler.handle(lockEvent({ tenantId: 'system' }))).resolves.toEqual({
      kind: 'ack',
    });

    expect(mockSignedFetch).toHaveBeenCalledWith(
      expect.stringContaining('/internal/users/user-1/pii'),
      expect.objectContaining({ tenantId: '', audience: 'auth-service' }),
    );
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    expect(emailService.sendEmail.mock.calls[0]?.[0]).toBe('root@example.test');
  });

  it('SEC-HIGH-057 / PLAT-HIGH-902: a malformed tenancy scope is terminated, never acknowledged or redelivered', async () => {
    await expect(handler.handle(lockEvent({ tenantId: 'not-a-tenant' }))).resolves.toEqual(
      expect.objectContaining({
        kind: 'terminate',
        cause: expect.any(InvalidEventTenantScopeError),
      }),
    );

    expect(mockSignedFetch).not.toHaveBeenCalled();
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  it('terminates malformed events missing lockedUntil', async () => {
    // Empty string models a malformed producer — falsy, caught by the guard.
    await expect(handler.handle(lockEvent({ lockedUntil: '' }))).resolves.toEqual(
      expect.objectContaining({ kind: 'terminate' }),
    );

    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  it('PLAT-HIGH-902: a transient SMTP failure is a retry, a permanent one a terminate', async () => {
    mockSignedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: { email: 'owner@example.test', firstName: 'Okan' },
    });
    emailService.sendEmail.mockRejectedValueOnce(
      new EmailDeliveryError('450 greylisted', 'transient'),
    );
    await expect(handler.handle(lockEvent())).resolves.toEqual(
      expect.objectContaining({ kind: 'retry' }),
    );

    emailService.sendEmail.mockRejectedValueOnce(
      new EmailDeliveryError('SMTP transporter is not configured', 'permanent'),
    );
    await expect(handler.handle(lockEvent())).resolves.toEqual(
      expect.objectContaining({ kind: 'terminate' }),
    );
  });
});
