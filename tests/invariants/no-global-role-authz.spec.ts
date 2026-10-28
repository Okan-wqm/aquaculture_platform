/**
 * INVARIANT: in a `module-access` service the global role never decides module power (ADR-051 §1,
 * §3, Enforcement; plan §2 "the global role never grants module access"; RBAC-HIGH-031).
 *
 * `users.role` (the token's `role`/`roles`) and the legacy `modules` list are tenant-wide: a
 * manager of farm holds MODULE_MANAGER for every module, so any check that reads them for module
 * power lets one module's manager into another's data (payrolls for a farm manager). In a
 * `module-access` service module power comes only from `@AccessCaller()` (its `effectiveRoles`,
 * `moduleScope` and `member`), decided by `decideAccess` from the `moduleAccess` claim.
 *
 * The service list is MODULE_ACCESS_ENROLMENT's `module-access` entries, so the rule holds
 * vacuously in R1 and binds each service from the PR that flips it (PKG-07, PKG-08, PKG-11,
 * PKG-12, PKG-25): such a service reads no `.role`, `.roles` or `.modules` of a user-shaped value,
 * names no such claim in `@CurrentUser(...)`, and calls none of the global-role hierarchy helpers.
 * The self-tests run the reader on fixture sources, and the real-tree check shows the account-role
 * services still read the global role, so the rule cannot pass because it reads nothing.
 *
 * PKG-46 PR1 (R5) extends this spec to the `account-role` services: no `@Roles` there names
 * MODULE_MANAGER, and no imperative check anywhere reads `users.role` for module power.
 */
import {
  ACCESS_ENROLLED_SERVICES,
  MODULE_ACCESS_ENROLMENT,
  moduleAccessServices,
} from '../../libs/backend-common/src/security/access-enrolment';

import { globalRoleReads, serviceGlobalRoleReads } from './helpers/module-access-registration';

describe('INVARIANT: no global-role authorization in module-access services (ADR-051 §1)', () => {
  it('no module-access service reads users.role or modules for a decision', () => {
    expect(moduleAccessServices().flatMap(serviceGlobalRoleReads)).toEqual([]);
  });

  it('the rule bites the real tree: the account-role services still read the global role', () => {
    const reads = ACCESS_ENROLLED_SERVICES.filter(
      (service) => MODULE_ACCESS_ENROLMENT[service] === 'account-role',
    ).flatMap(serviceGlobalRoleReads);
    expect(reads.length).toBeGreaterThan(0);
  });
});

describe('global-role reader — self-tests on fixture sources', () => {
  const read = (source: string): string[] => globalRoleReads('fixture.ts', source);

  it('reads role, roles and modules of a user-shaped value', () => {
    expect(read('if (viewer.roles?.includes(Role.MODULE_MANAGER)) {}')).toEqual([
      'fixture.ts:1 viewer.roles',
    ]);
    expect(read('const r = req.user.role;')).toEqual(['fixture.ts:1 req.user.role']);
    expect(read("const m = currentUser['modules'];")).toEqual([
      "fixture.ts:1 currentUser['modules']",
    ]);
    expect(read('const { roles } = user;')).toEqual(['fixture.ts:1 { roles } = user']);
  });

  it('reads @CurrentUser of a global claim and the global-role helpers', () => {
    expect(read("function f(@CurrentUser('roles') roles: string[]) {}")).toEqual([
      "fixture.ts:1 CurrentUser('roles')",
    ]);
    expect(read('roleHasPermission(user.role, Role.MODULE_MANAGER);')).toEqual([
      'fixture.ts:1 roleHasPermission(...)',
      'fixture.ts:1 user.role',
    ]);
  });

  it('does not read the decided caller, other objects, comments or strings', () => {
    expect(read('if (caller.effectiveRoles.includes(Role.MODULE_MANAGER)) {}')).toEqual([]);
    expect(read('const a = caller.member.accountRole;')).toEqual([]);
    expect(read('const s = dto.roles; // user.roles')).toEqual([]);
    expect(read("const t = 'user.roles';")).toEqual([]);
  });
});
