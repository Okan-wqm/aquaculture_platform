import { NotificationResolver } from './notification.resolver';

/**
 * NotificationResolver device-token lifecycle tests — MT-HIGH-050.
 *
 * AquaMobil runs on SHARED devices. On logout the FCM device token must be
 * deregistered so push for the prior tenant/user does not reach the next user on
 * the same phone. These tests prove unregisterDeviceToken deletes ONLY the
 * caller-owned (token, userId, tenantId) row and is idempotent.
 */

interface UserContext {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
}

const USER: UserContext = {
  sub: 'user-aaaa',
  email: 'a@b.com',
  tenantId: 'tenant-xyz',
  roles: ['OPERATOR'],
};

function createResolver(): {
  resolver: NotificationResolver;
  deleteMock: jest.Mock;
} {
  const deleteMock = jest.fn().mockResolvedValue({ affected: 1, raw: [] });
  // Only `delete` is exercised by unregisterDeviceToken. The `as never` partial
  // mock injection is the repo's sanctioned spec idiom (see
  // notification-dispatcher.service.spec.ts) — no double-cast hack needed.
  const repo = { delete: deleteMock };

  const resolver = new NotificationResolver(
    {} as never,
    {} as never,
    repo as never,
  );

  return { resolver, deleteMock };
}

describe('NotificationResolver.unregisterDeviceToken (MT-HIGH-050)', () => {
  it('deletes ONLY the row scoped to the caller token + userId + tenantId', async () => {
    const { resolver, deleteMock } = createResolver();

    const result = await resolver.unregisterDeviceToken('fcm-token-123', USER, USER.tenantId);

    expect(result).toBe(true);
    // The delete criteria MUST bind all three dimensions so a caller can only
    // remove its own mapping — never another user's or tenant's token.
    expect(deleteMock).toHaveBeenCalledWith({
      token: 'fcm-token-123',
      userId: USER.sub,
      tenantId: USER.tenantId,
    });
  });

  it('is idempotent — returns true even when no matching row exists', async () => {
    const { resolver, deleteMock } = createResolver();
    deleteMock.mockResolvedValueOnce({ affected: 0, raw: [] });

    const result = await resolver.unregisterDeviceToken('absent-token', USER, USER.tenantId);

    expect(result).toBe(true);
  });

  it('returns false (not throws) when the delete fails, so logout does not crash', async () => {
    const { resolver, deleteMock } = createResolver();
    deleteMock.mockRejectedValueOnce(new Error('db down'));

    const result = await resolver.unregisterDeviceToken('fcm-token-123', USER, USER.tenantId);

    expect(result).toBe(false);
  });
});
