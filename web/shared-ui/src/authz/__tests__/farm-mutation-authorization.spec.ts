import { FARM_MUTATION_AUTHORIZATION } from '@platform/event-contracts';
import { isPlatformRole } from '@platform/identity';
import { describe, expect, it } from 'vitest';

import { FRONTEND_MUTATION_ROLES } from '../farm-mutation-authorization.generated';

describe('generated frontend farm mutation authorization projection', () => {
  it('contains only canonical contract references for real UI demands', () => {
    expect(Object.keys(FRONTEND_MUTATION_ROLES).length).toBeGreaterThan(30);
    for (const [mutation, roles] of Object.entries(FRONTEND_MUTATION_ROLES)) {
      const canonical = Object.entries(FARM_MUTATION_AUTHORIZATION).find(
        ([operation]) => operation === mutation,
      );
      expect(canonical).toBeDefined();
      expect(roles).toBe(canonical?.[1]);
      expect(roles.every(isPlatformRole)).toBe(true);
    }
  });

  it('freezes the projection and its canonical role arrays', () => {
    expect(Object.isFrozen(FRONTEND_MUTATION_ROLES)).toBe(true);
    expect(Object.values(FRONTEND_MUTATION_ROLES).every(Object.isFrozen)).toBe(true);
  });
});
