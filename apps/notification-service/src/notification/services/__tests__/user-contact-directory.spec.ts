import { signedFetchJson } from '@aquaculture/backend-common/http';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { DeviceToken } from '../../entities/device-token.entity';

import { UserContactDirectory, UserContactLookupError } from '../user-contact-directory.service';

jest.mock('@aquaculture/backend-common/http', () => ({
  signedFetch: jest.fn(),
  signedFetchJson: jest.fn(),
}));

/**
 * ALERT-CRITICAL-004 — the one place notification-service turns a tenant user
 * into something deliverable. Pins the auth-service contract of the alarm
 * recipient expansion (route, identity, body) and that anything but ids is
 * refused at the boundary.
 */
const TENANT_ID = '7f6b08ab-90e2-46d3-8a11-2b3c4d5e6f70';
const USER = '22222222-2222-4222-8222-222222222222';
const SITE = '11111111-1111-4111-8111-111111111111';

async function build(): Promise<{
  directory: UserContactDirectory;
  tokens: { findOne: jest.Mock };
}> {
  const tokens = { findOne: jest.fn() };
  const moduleRef = await Test.createTestingModule({
    providers: [
      UserContactDirectory,
      { provide: getRepositoryToken(DeviceToken), useValue: tokens },
      {
        provide: ConfigService,
        useValue: new ConfigService({ AUTH_SERVICE_INTERNAL_URL: 'http://auth-internal/' }),
      },
    ],
  }).compile();
  return { directory: moduleRef.get(UserContactDirectory), tokens };
}

describe('UserContactDirectory', () => {
  beforeEach(() => jest.clearAllMocks());

  it('expands alarm targets through auth-service, tenant-bound, ids only', async () => {
    // SCENARIO: the default policy's targets for one site.
    // EXPECTS: a signed POST to auth's internal route bound to the tenant, and the
    //          validated id list back.
    (signedFetchJson as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      body: { userIds: [USER], truncated: false },
    });
    const { directory } = await build();
    const query = {
      tenantWideRoles: ['TENANT_ADMIN' as const],
      siteRoles: ['MODULE_MANAGER' as const],
      siteId: SITE,
      userIds: [],
    };

    await expect(directory.alertRecipients(TENANT_ID, query)).resolves.toEqual({
      userIds: [USER],
      truncated: false,
    });
    expect(signedFetchJson).toHaveBeenCalledWith(
      `http://auth-internal/api/v1/internal/tenants/${TENANT_ID}/alert-recipients`,
      expect.objectContaining({
        method: 'POST',
        serviceName: 'notification-service',
        tenantId: TENANT_ID,
        audience: 'auth-service',
        body: JSON.stringify(query),
      }),
    );
  });

  it('refuses a reply that carries anything but ids (no PII through this surface)', async () => {
    // SCENARIO: a reply that grew an e-mail field.
    // EXPECTS: a permanent lookup error — the schema forbids extra properties.
    (signedFetchJson as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      body: { userIds: [USER], truncated: false, emails: ['a@b.c'] },
    });
    const { directory } = await build();

    await expect(
      directory.alertRecipients(TENANT_ID, {
        tenantWideRoles: [],
        siteRoles: [],
        siteId: null,
        userIds: [USER],
      }),
    ).rejects.toEqual(expect.objectContaining({ failureClass: 'permanent' }));
  });

  it('keeps the transport failure class so the handler retries a 503', async () => {
    // SCENARIO: auth-service answers 503.
    // EXPECTS: a transient UserContactLookupError (the bus retries it).
    (signedFetchJson as jest.Mock).mockResolvedValue({
      ok: false,
      status: 503,
      failureClass: 'transient',
      error: 'HTTP 503',
    });
    const { directory } = await build();

    const failure = directory.alertRecipients(TENANT_ID, {
      tenantWideRoles: ['TENANT_ADMIN'],
      siteRoles: [],
      siteId: null,
      userIds: [],
    });
    await expect(failure).rejects.toBeInstanceOf(UserContactLookupError);
    await expect(failure).rejects.toEqual(expect.objectContaining({ failureClass: 'transient' }));
  });

  it('reads the latest device token of the user in this tenant only', async () => {
    // SCENARIO: push reachability comes from notification-service's own registry.
    // EXPECTS: a tenant+user scoped lookup, newest device first; null when none.
    const { directory, tokens } = await build();
    tokens.findOne.mockResolvedValueOnce({ token: 'device-1' }).mockResolvedValueOnce(null);

    await expect(directory.latestPushToken(TENANT_ID, USER)).resolves.toBe('device-1');
    await expect(directory.latestPushToken(TENANT_ID, USER)).resolves.toBeNull();
    expect(tokens.findOne).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, userId: USER },
      order: { lastSeenAt: 'DESC', createdAt: 'DESC' },
    });
  });

  it.each([
    [502, 'transient'],
    [401, 'transient'],
    [403, 'transient'],
    [429, 'transient'],
    [404, 'permanent'],
  ])(
    'classifies an e-mail lookup HTTP %i as %s through the platform classifier (V-S1a-6)',
    async (status, failureClass) => {
      // SCENARIO: auth's PII endpoint fails; 401/403/429 are an auth restart or a
      //           key rotation, not a missing user.
      // EXPECTS: the platform SSoT's class — only a rejected request is permanent.
      const { directory } = await build();
      const { classifyHttpStatus } = jest.requireActual<
        typeof import('@aquaculture/backend-common/http')
      >('@aquaculture/backend-common/http');
      (signedFetchJson as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status,
        failureClass: classifyHttpStatus(status),
        error: `HTTP ${status}`,
      });

      await expect(directory.email(TENANT_ID, USER)).rejects.toEqual(
        expect.objectContaining({ failureClass }),
      );
    },
  );

  it('treats a refused connection to auth as transient (signedFetchJson catches it)', async () => {
    const { directory } = await build();
    (signedFetchJson as jest.Mock).mockResolvedValueOnce({
      ok: false,
      failureClass: 'transient',
      error: 'connect ECONNREFUSED',
    });

    await expect(directory.email(TENANT_ID, USER)).rejects.toEqual(
      expect.objectContaining({ failureClass: 'transient' }),
    );
  });

  it('returns the address from a successful lookup', async () => {
    const { directory } = await build();
    (signedFetchJson as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { email: 'manager@farm.test' },
    });

    await expect(directory.email(TENANT_ID, USER)).resolves.toBe('manager@farm.test');
  });
});
