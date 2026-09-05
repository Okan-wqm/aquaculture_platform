import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { InvalidEventTenantScopeError } from '@platform/event-contracts';
import type { UserAccountLockedEvent } from '@platform/event-contracts';

import { AuthEventHandler } from './auth-event.handler';
import { EmailService } from '../services/email.service';

import { signedFetch } from '@aquaculture/backend-common/http';

jest.mock('@aquaculture/backend-common/http', () => ({
  signedFetch: jest.fn(),
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
  const mockSignedFetch = signedFetch as jest.MockedFunction<typeof signedFetch>;

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
      json: () => Promise.resolve({ email: 'owner@example.test', firstName: 'Okan' }),
    } as Response);

    await handler.handle(lockEvent());

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

  it('skips (no email) when PII resolution fails — never throws into the bus', async () => {
    mockSignedFetch.mockResolvedValue({ ok: false, status: 503 } as Response);

    await handler.handle(lockEvent());

    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  it('SEC-HIGH-057: a platform-scoped lockout (super admin) resolves PII through the platform-scope identity', async () => {
    mockSignedFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ email: 'root@example.test', firstName: 'Root' }),
    } as Response);

    await handler.handle(lockEvent({ tenantId: 'system' }));

    expect(mockSignedFetch).toHaveBeenCalledWith(
      expect.stringContaining('/internal/users/user-1/pii'),
      expect.objectContaining({ tenantId: '', audience: 'auth-service' }),
    );
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    expect(emailService.sendEmail.mock.calls[0]?.[0]).toBe('root@example.test');
  });

  it('SEC-HIGH-057: a malformed tenancy scope throws to the bus instead of being acknowledged', async () => {
    await expect(handler.handle(lockEvent({ tenantId: 'not-a-tenant' }))).rejects.toThrow(
      InvalidEventTenantScopeError,
    );

    expect(mockSignedFetch).not.toHaveBeenCalled();
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  it('skips malformed events missing lockedUntil', async () => {
    // Empty string models a malformed producer — falsy, caught by the guard.
    await handler.handle(lockEvent({ lockedUntil: '' }));

    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });
});
