import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { InvalidEventTenantScopeError } from '@platform/event-contracts';
import type { PasswordResetRequestedEvent, UserInvitedEvent } from '@platform/event-contracts';

import { AuthEventHandler } from './auth-event.handler';
import { EmailService } from '../services/email.service';

import { signedFetch } from '@aquaculture/backend-common/http';

jest.mock('@aquaculture/backend-common/http', () => ({
  signedFetch: jest.fn(),
}));

/**
 * SEC-HIGH-159 — a super admin's password-reset e-mail was acknowledged and
 * never sent: the handler guarded `tenantId` with a UUID regex and returned
 * on the platform segment. These tests pin the scope-aware delivery path:
 * tenant events bind the tenant id into the signed internal call, platform
 * events bind the explicit non-tenant identity, UserInvited refuses the
 * platform scope, and a malformed scope throws to the bus.
 */
describe('AuthEventHandler — PasswordResetRequested / UserInvited tenancy scope (SEC-HIGH-159)', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const ACTION_TOKEN_ID = '22222222-2222-4222-8222-222222222222';
  const mockSignedFetch = signedFetch as jest.MockedFunction<typeof signedFetch>;

  const emailService = {
    sendEmail: jest.fn().mockResolvedValue('message-id-1'),
    sendWelcomeEmail: jest.fn().mockResolvedValue('message-id-2'),
  };
  const eventBus = { subscribeWildcard: jest.fn().mockResolvedValue(undefined) };
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

  const resetEvent = (
    overrides: Partial<PasswordResetRequestedEvent> = {},
  ): PasswordResetRequestedEvent =>
    ({
      eventId: 'event-1',
      eventType: 'PasswordResetRequested',
      timestamp: new Date().toISOString(),
      tenantId: TENANT,
      version: 2,
      aggregateId: 'user-1',
      aggregateType: 'User',
      userId: 'user-1',
      actionTokenId: ACTION_TOKEN_ID,
      cryptoShredKeyId: 'user-1',
      ...overrides,
    }) as PasswordResetRequestedEvent;

  const inviteEvent = (overrides: Partial<UserInvitedEvent> = {}): UserInvitedEvent =>
    ({
      eventId: 'event-2',
      eventType: 'UserInvited',
      timestamp: new Date().toISOString(),
      tenantId: TENANT,
      version: 1,
      aggregateId: 'user-2',
      aggregateType: 'User',
      userId: 'user-2',
      role: 'MODULE_USER',
      invitedBy: 'admin-1',
      credentialType: 'reset_token',
      actionTokenId: ACTION_TOKEN_ID,
      cryptoShredKeyId: 'user-2',
      ...overrides,
    }) as UserInvitedEvent;

  /** signedFetch double that answers the PII, tenant-info and action-url routes. */
  function answerInternalApi(): void {
    mockSignedFetch.mockImplementation((url: string | URL) => {
      const path = String(url);
      const body = path.includes('/pii')
        ? { email: 'someone@example.test', firstName: 'Some' }
        : path.includes('/info')
          ? { name: 'Acme Farms' }
          : { actionUrl: `https://app.example.test/reset-password/${ACTION_TOKEN_ID}` };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    emailService.sendEmail.mockResolvedValue('message-id-1');
    emailService.sendWelcomeEmail.mockResolvedValue('message-id-2');
  });

  it('a tenant user reset binds the tenant id into both internal calls', async () => {
    answerInternalApi();

    await handler.handle(resetEvent());

    const bindings = mockSignedFetch.mock.calls.map(([url, init]) => [String(url), init?.tenantId]);
    expect(bindings).toEqual(
      expect.arrayContaining([
        [expect.stringContaining('/internal/users/user-1/pii'), TENANT],
        [expect.stringContaining(`/internal/action-tokens/${ACTION_TOKEN_ID}/url`), TENANT],
      ]),
    );
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const [to, , html] = emailService.sendEmail.mock.calls[0] as [string, string, string];
    expect(to).toBe('someone@example.test');
    expect(html).toContain(`https://app.example.test/reset-password/${ACTION_TOKEN_ID}`);
  });

  it('a super admin reset (platform scope) is delivered through the platform-scope identity, never dropped', async () => {
    answerInternalApi();

    await handler.handle(resetEvent({ tenantId: 'system' }));

    const bindings = mockSignedFetch.mock.calls.map(([url, init]) => [String(url), init?.tenantId]);
    expect(bindings).toEqual(
      expect.arrayContaining([
        [expect.stringContaining('/internal/users/user-1/pii'), ''],
        [expect.stringContaining(`/internal/action-tokens/${ACTION_TOKEN_ID}/url`), ''],
      ]),
    );
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('a malformed scope throws to the bus instead of being acknowledged', async () => {
    await expect(handler.handle(resetEvent({ tenantId: 'tenant-1' }))).rejects.toThrow(
      InvalidEventTenantScopeError,
    );
    expect(mockSignedFetch).not.toHaveBeenCalled();
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  it('a tenant invitation resolves PII, tenant info and the link under the tenant binding', async () => {
    answerInternalApi();

    await handler.handle(inviteEvent());

    expect(mockSignedFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/internal/tenants/${TENANT}/info`),
      expect.objectContaining({ tenantId: TENANT }),
    );
    expect(emailService.sendWelcomeEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'someone@example.test',
        tenantName: 'Acme Farms',
        actionUrl: `https://app.example.test/reset-password/${ACTION_TOKEN_ID}`,
      }),
    );
  });

  it('UserInvited refuses the platform scope: an invitation always targets a tenant', async () => {
    // The scope violation is a contract error and surfaces through the
    // handler's error boundary as a logged, non-delivered event.
    await handler.handle(inviteEvent({ tenantId: 'system' }));

    expect(mockSignedFetch).not.toHaveBeenCalled();
    expect(emailService.sendWelcomeEmail).not.toHaveBeenCalled();
  });
});
