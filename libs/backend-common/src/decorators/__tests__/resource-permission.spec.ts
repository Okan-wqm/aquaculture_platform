import 'reflect-metadata';
import type { TenantCapability } from '@aquaculture/shared-contracts';

import {
  REQUIRED_TENANT_PERMISSIONS_KEY,
  RequireTenantPermission,
  hasAllResourcePermissions,
  hasResourcePermission,
} from '../require-permission.decorator';

/**
 * Faz 7c — the SSoT capability check shared by TenantPermissionGuard and any
 * programmatic/conditional callsite (e.g. the GROUP-only branch of createChannel).
 * Must exactly mirror the guard semantics: admin bypass + every-required
 * membership, fail-closed on a missing user.
 *
 * RBAC-MEDIUM-026: a check names only a catalogue capability. The decorator and both
 * functions take `TenantCapability`, so enforcing a key the role editor cannot grant (as
 * sensor-service did with `edge:manage-io-config`) no longer compiles.
 */

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe('a capability check names only a catalogue capability (RBAC-MEDIUM-026)', () => {
  it('types the decorator and both checks by TenantCapability', () => {
    const decorator: Equals<Parameters<typeof RequireTenantPermission>[number], TenantCapability> =
      true;
    const single: Equals<Parameters<typeof hasResourcePermission>[1], TenantCapability> = true;
    const all: Equals<
      Parameters<typeof hasAllResourcePermissions>[1],
      readonly TenantCapability[]
    > = true;
    expect([decorator, single, all]).toEqual([true, true, true]);
  });

  it('stores the named capabilities as handler metadata', () => {
    class Target {
      @RequireTenantPermission('roles:edit', 'users:view')
      handler(): string {
        return 'handled';
      }
    }
    expect(Reflect.getMetadata(REQUIRED_TENANT_PERMISSIONS_KEY, Target.prototype.handler)).toEqual([
      'roles:edit',
      'users:view',
    ]);
  });
});

describe('hasResourcePermission / hasAllResourcePermissions', () => {
  it('grants when the capability is in resourcePermissions', () => {
    const user = { role: 'MODULE_USER', resourcePermissions: ['channels:create_group'] };
    expect(hasResourcePermission(user, 'channels:create_group')).toBe(true);
  });

  it('denies when the capability is absent (fail-closed)', () => {
    const user = { role: 'MODULE_USER', resourcePermissions: ['ai_assistant:use'] };
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
    expect(hasResourcePermission({ role: 'SUPER_ADMIN' }, 'edge_devices:manage_io_config')).toBe(
      true,
    );
    expect(hasResourcePermission({ roles: ['TENANT_ADMIN'] }, 'company:view')).toBe(true);
  });

  it('normalizes lowercase / mixed-case roles for the admin bypass', () => {
    expect(hasResourcePermission({ role: 'tenant_admin' }, 'roles:delete')).toBe(true);
    expect(hasResourcePermission({ roles: ['Super_Admin'] }, 'roles:delete')).toBe(true);
  });

  it('requires EVERY capability for hasAllResourcePermissions', () => {
    const user = { role: 'MODULE_MANAGER', resourcePermissions: ['users:view', 'roles:view'] };
    expect(hasAllResourcePermissions(user, ['users:view', 'roles:view'])).toBe(true);
    expect(hasAllResourcePermissions(user, ['users:view', 'roles:edit'])).toBe(false);
  });

  it('an empty required list is vacuously granted for a present user', () => {
    expect(hasAllResourcePermissions({ role: 'MODULE_USER' }, [])).toBe(true);
  });
});
