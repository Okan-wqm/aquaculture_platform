import { Role } from '@aquaculture/backend-common/decorators';

import { splitInvitedRole, usersRoleColumn } from './account-role-column';

/**
 * users.role is an account role (ADR-051 §1; RBAC-HIGH-034). A new account is written with its
 * account role, TENANT_ADMIN, or as a member with MODULE_USER, the column's "no account power"
 * value: no writer of a new account can name the legacy global MODULE_MANAGER any more. An
 * invite still names one role for its modules; a module role goes to the grants, never to
 * users.role.
 */
describe('users.role for a new account', () => {
  it('writes an account role as itself and a member as MODULE_USER', () => {
    expect(usersRoleColumn('TENANT_ADMIN')).toBe(Role.TENANT_ADMIN);
    expect(usersRoleColumn('SUPER_ADMIN')).toBe(Role.SUPER_ADMIN);
    expect(usersRoleColumn(null)).toBe(Role.MODULE_USER);
  });

  it("splits an invite's role into the account role and the module role", () => {
    expect(splitInvitedRole(Role.TENANT_ADMIN)).toEqual({
      kind: 'account',
      accountRole: 'TENANT_ADMIN',
    });
    expect(splitInvitedRole(Role.MODULE_MANAGER)).toEqual({
      kind: 'member',
      moduleRole: 'MODULE_MANAGER',
    });
    expect(splitInvitedRole(Role.MODULE_USER)).toEqual({
      kind: 'member',
      moduleRole: 'MODULE_USER',
    });
  });
});
