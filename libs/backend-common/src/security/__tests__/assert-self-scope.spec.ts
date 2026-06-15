/**
 * SEC-HIGH-050 — canonical self-scope authorization SSoT unit tests.
 *
 * Pins the owner-or-manager + canonical-hierarchy-bypass + fail-closed shape
 * that task lifecycle mutations rely on.
 */
import { ForbiddenException } from '@nestjs/common';

import { Role } from '../../decorators/roles.decorator';
import { assertSelfOrManager } from '../assert-self-scope';

const OWNER = 'user-owner';
const OTHER = 'user-other';

describe('assertSelfOrManager', () => {
  it('allows the owner (direct auth-userId equality)', () => {
    expect(() =>
      assertSelfOrManager({
        ownerId: OWNER,
        caller: { sub: OWNER, roles: [Role.MODULE_USER] },
      }),
    ).not.toThrow();
  });

  it('denies a non-owner MODULE_USER (fail-closed)', () => {
    expect(() =>
      assertSelfOrManager({
        ownerId: OWNER,
        caller: { sub: OTHER, roles: [Role.MODULE_USER] },
      }),
    ).toThrow(ForbiddenException);
  });

  it('allows a non-owner MODULE_MANAGER via the canonical hierarchy bypass', () => {
    expect(() =>
      assertSelfOrManager({
        ownerId: OWNER,
        caller: { sub: OTHER, roles: [Role.MODULE_MANAGER] },
      }),
    ).not.toThrow();
  });

  it('allows a non-owner TENANT_ADMIN (hierarchy includes MODULE_MANAGER)', () => {
    expect(() =>
      assertSelfOrManager({
        ownerId: OWNER,
        caller: { sub: OTHER, roles: [Role.TENANT_ADMIN] },
      }),
    ).not.toThrow();
  });

  it('allows a non-owner SUPER_ADMIN', () => {
    expect(() =>
      assertSelfOrManager({
        ownerId: OWNER,
        caller: { sub: OTHER, roles: [Role.SUPER_ADMIN] },
      }),
    ).not.toThrow();
  });

  it('denies a non-owner with an empty role set (fail-closed)', () => {
    expect(() =>
      assertSelfOrManager({
        ownerId: OWNER,
        caller: { sub: OTHER, roles: [] },
      }),
    ).toThrow(ForbiddenException);
  });

  it('denies a non-owner whose role is unknown to the hierarchy (fail-closed)', () => {
    expect(() =>
      assertSelfOrManager({
        ownerId: OWNER,
        // an unmapped role string never satisfies roleHasPermission
        caller: { sub: OTHER, roles: ['SOMETHING_ELSE' as Role] },
      }),
    ).toThrow(ForbiddenException);
  });

  it('denies when ownerId is null and the caller is a non-manager (fail-closed)', () => {
    expect(() =>
      assertSelfOrManager({
        ownerId: null,
        caller: { sub: OTHER, roles: [Role.MODULE_USER] },
      }),
    ).toThrow(ForbiddenException);
  });

  it('denies when ownerId is undefined and the caller is a non-manager (fail-closed)', () => {
    expect(() =>
      assertSelfOrManager({
        ownerId: undefined,
        caller: { sub: OTHER, roles: [Role.MODULE_USER] },
      }),
    ).toThrow(ForbiddenException);
  });

  it('allows a MODULE_MANAGER even when ownerId is null (manager bypass is owner-independent)', () => {
    expect(() =>
      assertSelfOrManager({
        ownerId: null,
        caller: { sub: OTHER, roles: [Role.MODULE_MANAGER] },
      }),
    ).not.toThrow();
  });
});
