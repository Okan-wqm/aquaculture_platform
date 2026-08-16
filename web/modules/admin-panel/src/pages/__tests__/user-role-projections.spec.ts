import { INVITABLE_ROLE_CODES, PLATFORM_ROLE_CODES, Role } from '@platform/identity';
import { describe, expect, it } from 'vitest';

import {
  ALL_ROLE_OPTIONS,
  INVITABLE_ROLE_OPTIONS,
  selectedInvitableRole,
  selectedPlatformRole,
} from '../user-role-projections';

describe('admin user-page role projection', () => {
  it('projects exact canonical and invitable option sets', () => {
    expect(ALL_ROLE_OPTIONS.map((option) => option.value)).toEqual(PLATFORM_ROLE_CODES);
    expect(INVITABLE_ROLE_OPTIONS.map((option) => option.value)).toEqual(INVITABLE_ROLE_CODES);
    expect(Object.isFrozen(ALL_ROLE_OPTIONS)).toBe(true);
    expect(ALL_ROLE_OPTIONS.every(Object.isFrozen)).toBe(true);
  });

  it.each(['VIEWER', 'OPERATOR', 'MANAGER'])('fails legacy selection %s closed', (legacy) => {
    expect(selectedPlatformRole(legacy)).toBe(Role.MODULE_USER);
    expect(selectedInvitableRole(legacy)).toBe(Role.MODULE_USER);
  });
});
