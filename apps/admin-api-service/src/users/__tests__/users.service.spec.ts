/**
 * APA-052 regression: UsersService.getTenantName must schema-qualify the
 * tenants table as `auth.tenants`. admin-api runs search_path=admin,public
 * where a bare `tenants` relation does not exist (the SSoT is auth.tenants), so
 * the pre-fix query threw `relation "tenants" does not exist` and the swallowing
 * catch returned null — createUser/updateUser responses always reported
 * tenantName:null and logged a spurious error on every mutation.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/users-roles.md#APA-052
 */
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';

import { UsersService } from '../users.service';

describe('UsersService.getTenantName (APA-052)', () => {
  let service: UsersService;
  const query = jest.fn();

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    query.mockReset();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getDataSourceToken(), useValue: { query } },
        { provide: 'AUTH_NATS_CLIENT', useValue: { send: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(UsersService);
  });

  it('queries auth.tenants (not a bare `tenants` absent on the admin search_path)', async () => {
    query.mockResolvedValue([{ name: 'Acme Farms' }]);

    const name = await service.getTenantName('11111111-1111-4111-8111-111111111111');

    expect(name).toBe('Acme Farms');
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toMatch(/from\s+auth\.tenants/i);
    expect(sql).not.toMatch(/from\s+tenants\b/i);
  });
});
