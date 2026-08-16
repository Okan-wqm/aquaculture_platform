import { PLATFORM_ROLE_CODES } from '@platform/identity';

import { MUTATION_ROLES, QUERY_ROLES, resolveAllowedRoles } from '../permission-matrix';

describe('generated farm operation authorization contract', () => {
  it('contains the complete GraphQL root-operation surface', () => {
    expect(Object.keys(MUTATION_ROLES).length).toBeGreaterThanOrEqual(150);
    expect(Object.keys(QUERY_ROLES).length).toBeGreaterThanOrEqual(150);
  });

  it('deep-freezes non-empty canonical role sets', () => {
    expect(Object.isFrozen(MUTATION_ROLES)).toBe(true);
    expect(Object.isFrozen(QUERY_ROLES)).toBe(true);

    for (const roles of [...Object.values(MUTATION_ROLES), ...Object.values(QUERY_ROLES)]) {
      expect(Object.isFrozen(roles)).toBe(true);
      expect(roles.length).toBeGreaterThan(0);
      expect(roles.every((role) => PLATFORM_ROLE_CODES.includes(role))).toBe(true);
      expect(new Set(roles).size).toBe(roles.length);
    }
  });

  it('resolves generated mutation and query audiences and fails closed for unknown names', () => {
    expect(resolveAllowedRoles('closeBatch')).toEqual(MUTATION_ROLES.closeBatch);
    expect(resolveAllowedRoles('harvestPlans')).toEqual(QUERY_ROLES.harvestPlans);
    expect(resolveAllowedRoles('unknownOperation')).toBeUndefined();
  });
});
