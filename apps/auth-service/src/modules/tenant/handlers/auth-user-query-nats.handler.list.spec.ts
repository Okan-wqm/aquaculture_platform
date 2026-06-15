import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';

import { AuditLogService } from '../../../audit/audit-log.service';
import { User } from '../../authentication/entities/user.entity';
import { AuthUserQueryNatsHandler } from './auth-user-query-nats.handler';

/**
 * MSG-HIGH-051 / SECURITY: the tenant user-ID enumeration must stay tenant-scoped,
 * active-only, and return ONLY IDs (no PII) — the New Chat picker's data source
 * never becomes a profile-harvesting oracle. The tenantId is the NATS trust
 * boundary and must be UUID-validated before any query runs.
 */
describe('AuthUserQueryNatsHandler.listTenantUserIds', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';
  let handler: AuthUserQueryNatsHandler;
  let find: jest.Mock;

  beforeEach(async () => {
    find = jest.fn();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthUserQueryNatsHandler,
        { provide: getRepositoryToken(User), useValue: { find } },
        { provide: AuditLogService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    handler = moduleRef.get(AuthUserQueryNatsHandler);
  });

  it('returns active tenant user IDs only, scoped by tenant', async () => {
    find.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);

    const result = await handler.listTenantUserIds({ tenantId });

    expect(find).toHaveBeenCalledWith({
      select: ['id'],
      where: { tenantId, isActive: true },
    });
    expect(result).toEqual({ success: true, userIds: ['a', 'b'] });
  });

  it('rejects a malformed tenantId WITHOUT touching the database', async () => {
    const result = await handler.listTenantUserIds({ tenantId: 'not-a-uuid' });

    expect(result.success).toBe(false);
    expect(result.userIds).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });

  it('fails closed (empty, no throw) when the repository errors', async () => {
    find.mockRejectedValue(new Error('db gone'));

    const result = await handler.listTenantUserIds({ tenantId });

    expect(result.success).toBe(false);
    expect(result.userIds).toEqual([]);
  });
});
