import { AUTH_USER_QUERY_SUBJECTS } from '@platform/event-contracts';

import { AuthUserQueryNatsHandler } from '../auth-user-query-nats.handler';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

interface UserRow {
  id: string;
  tenantId: string;
  isActive: boolean;
}

function makeHandler(rows: UserRow[]): {
  handler: AuthUserQueryNatsHandler;
  audit: { recordAwait: jest.Mock };
  find: jest.Mock;
} {
  const find = jest.fn().mockResolvedValue(rows);
  const audit = { recordAwait: jest.fn().mockResolvedValue(undefined) };
  const handler = new AuthUserQueryNatsHandler(
    { find } as never,
    audit as never,
  );
  return { handler, audit, find };
}

describe('AuthUserQueryNatsHandler', () => {
  it('subject is the request.auth.* request/reply pattern', () => {
    expect(AUTH_USER_QUERY_SUBJECTS.VALIDATE_TENANT_MEMBERSHIP).toBe(
      'request.auth.user.validateTenantMembership',
    );
  });

  it('rejects a malformed payload at the trust boundary without querying', async () => {
    const { handler, find } = makeHandler([]);
    const result = await handler.validateTenantMembership({
      tenantId: 'not-a-uuid',
      userIds: [U1],
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('VALIDATION_ERROR');
    expect(find).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the tenant — a cross-tenant userId is invalid, not leaked', async () => {
    // U2 is omitted from the result set => belongs to another tenant (or
    // does not exist); both must collapse to invalidUserIds identically.
    const { handler, find, audit } = makeHandler([
      { id: U1, tenantId: TENANT, isActive: true },
    ]);
    const result = await handler.validateTenantMembership({
      tenantId: TENANT,
      userIds: [U1, U2],
    });
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: TENANT }) }),
    );
    expect(result.allValid).toBe(false);
    expect(result.validUserIds).toEqual([U1]);
    expect(result.invalidUserIds).toEqual([U2]);
    // A rejected validation is an awaited security audit.
    expect(audit.recordAwait).toHaveBeenCalledTimes(1);
  });

  it('requireActive=true pushes inactive members to inactiveUserIds AND forces allValid=false', async () => {
    const { handler } = makeHandler([
      { id: U1, tenantId: TENANT, isActive: false },
    ]);
    const result = await handler.validateTenantMembership({
      tenantId: TENANT,
      userIds: [U1],
      requireActive: true,
    });
    expect(result.allValid).toBe(false);
    expect(result.inactiveUserIds).toEqual([U1]);
    expect(result.validUserIds).toEqual([]);
  });

  it('requireActive=false keeps an inactive member valid', async () => {
    const { handler } = makeHandler([
      { id: U1, tenantId: TENANT, isActive: false },
    ]);
    const result = await handler.validateTenantMembership({
      tenantId: TENANT,
      userIds: [U1],
      requireActive: false,
    });
    expect(result.allValid).toBe(true);
    expect(result.validUserIds).toEqual([U1]);
    expect(result.inactiveUserIds).toEqual([]);
  });
});
