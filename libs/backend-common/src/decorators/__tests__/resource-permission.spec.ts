import 'reflect-metadata';
import {
  hasAllResourcePermissions,
  hasResourcePermission,
} from '../require-permission.decorator';

/**
 * Faz 7c — the SSoT capability check shared by TenantPermissionGuard and any
 * programmatic/conditional callsite (e.g. the GROUP-only branch of createChannel).
 * Must exactly mirror the guard semantics: admin bypass + every-required
 * membership, fail-closed on a missing user.
 */
describe('hasResourcePermission / hasAllResourcePermissions', () => {
  it('grants when the capability is in resourcePermissions', () => {
    const user = { role: 'MODULE_USER', resourcePermissions: ['channels:create_group'] };
    expect(hasResourcePermission(user, 'channels:create_group')).toBe(true);
  });

  it('denies when the capability is absent (fail-closed)', () => {
    const user = { role: 'MODULE_USER', resourcePermissions: ['messages:send'] };
    expect(hasResourcePermission(user, 'channels:create_group')).toBe(false);
  });

  it('denies when resourcePermissions is missing entirely', () => {
    expect(hasResourcePermission({ role: 'MODULE_USER' }, 'channels:create_group')).toBe(false);
  });

  it('denies for a null/undefined user', () => {
    expect(hasResourcePermission(null, 'channels:create_group')).toBe(false);
    expect(hasResourcePermission(undefined, 'channels:create_group')).toBe(false);
  });

  it('SUPER_ADMIN and TENANT_ADMIN bypass regardless of resourcePermissions', () => {
    expect(hasResourcePermission({ role: 'SUPER_ADMIN' }, 'anything:at-all')).toBe(true);
    expect(hasResourcePermission({ roles: ['TENANT_ADMIN'] }, 'anything:at-all')).toBe(true);
  });

  it('normalizes lowercase / mixed-case roles for the admin bypass', () => {
    expect(hasResourcePermission({ role: 'tenant_admin' }, 'x:y')).toBe(true);
    expect(hasResourcePermission({ roles: ['Super_Admin'] }, 'x:y')).toBe(true);
  });

  it('requires EVERY capability for hasAllResourcePermissions', () => {
    const user = { role: 'MODULE_MANAGER', resourcePermissions: ['a:x', 'b:y'] };
    expect(hasAllResourcePermissions(user, ['a:x', 'b:y'])).toBe(true);
    expect(hasAllResourcePermissions(user, ['a:x', 'c:z'])).toBe(false);
  });

  it('an empty required list is vacuously granted for a present user', () => {
    expect(hasAllResourcePermissions({ role: 'MODULE_USER' }, [])).toBe(true);
  });
});
