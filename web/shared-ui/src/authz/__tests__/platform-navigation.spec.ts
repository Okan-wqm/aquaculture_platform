import { Role, roleAtLeast } from '@platform/identity';
import { describe, expect, it } from 'vitest';

import {
  MODULE_USER_BASE_NAVIGATION,
  PLATFORM_MODULE_NAVIGATION,
  TENANT_ADMIN_NAVIGATION,
  TENANT_DELEGATED_CAPABILITIES,
} from '../platform-navigation';

interface FrozenItem {
  readonly children?: readonly FrozenItem[];
}

function allItemsFrozen(items: readonly FrozenItem[]): boolean {
  return items.every(
    (item) =>
      Object.isFrozen(item) &&
      (item.children === undefined ||
        (Object.isFrozen(item.children) && allItemsFrozen(item.children))),
  );
}

describe('platform navigation authorization projection', () => {
  it('uses one capability authority for tenant delegation', () => {
    const delegated = TENANT_ADMIN_NAVIGATION.filter(
      (item) => (item.requiredPermissions?.length ?? 0) > 0,
    );
    expect(delegated.map((item) => item.requiredPermissions?.[0]).sort()).toEqual(
      Object.values(TENANT_DELEGATED_CAPABILITIES).sort(),
    );
  });

  it('derives finance visibility from the canonical manager role floor', () => {
    const financeItems = Object.values(PLATFORM_MODULE_NAVIGATION)
      .flatMap((item) => item.children ?? [])
      .filter((item) => item.id.endsWith('finance'));
    for (const item of financeItems) {
      expect(item.requiredRoles?.every((role) => roleAtLeast(role, Role.MODULE_MANAGER))).toBe(true);
      expect(item.requiredRoles).not.toContain(Role.MODULE_USER);
    }
  });

  it('deep-freezes every exported navigation projection', () => {
    expect(Object.isFrozen(TENANT_ADMIN_NAVIGATION)).toBe(true);
    expect(Object.isFrozen(MODULE_USER_BASE_NAVIGATION)).toBe(true);
    expect(Object.isFrozen(PLATFORM_MODULE_NAVIGATION)).toBe(true);
    expect(Object.isFrozen(TENANT_DELEGATED_CAPABILITIES)).toBe(true);
    expect(allItemsFrozen(TENANT_ADMIN_NAVIGATION)).toBe(true);
    expect(allItemsFrozen(MODULE_USER_BASE_NAVIGATION)).toBe(true);
    expect(allItemsFrozen(Object.values(PLATFORM_MODULE_NAVIGATION))).toBe(true);
  });
});
