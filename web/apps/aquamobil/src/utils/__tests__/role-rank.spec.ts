// SEC-MEDIUM-050 / FE-MEDIUM-051 — role-rank SSoT parity with backend ROLE_HIERARCHY.
//
// The backend ROLE_HIERARCHY (libs/backend-common/src/decorators/roles.decorator.ts)
// is the authority: SUPER_ADMIN > TENANT_ADMIN > MODULE_MANAGER > MODULE_USER,
// where roleHasPermission(role, floor) is true iff role === floor or role is
// strictly higher. These tests assert meetsRoleFloor reproduces that ordering so
// the client never disagrees with the server's @Roles gate.

import { describe, it, expect } from 'vitest';

import { PLATFORM_ROLE_CODES, PLATFORM_ROLE_DEFINITIONS } from '@platform/identity';
import type { Role } from '../../generated/graphql';
import { roleRank, meetsRoleFloor } from '../role-rank';

const ORDERED_HIGH_TO_LOW: readonly Role[] = [...PLATFORM_ROLE_CODES].sort(
  (left, right) => PLATFORM_ROLE_DEFINITIONS[right].level - PLATFORM_ROLE_DEFINITIONS[left].level,
);

describe('roleRank', () => {
  it('ranks strictly decreasing from SUPER_ADMIN down to MODULE_USER', () => {
    const ranks = ORDERED_HIGH_TO_LOW.map(roleRank);
    for (let i = 1; i < ranks.length; i += 1) {
      expect(ranks[i - 1]).toBeGreaterThan(ranks[i]);
    }
  });
});

describe('meetsRoleFloor — parity with backend roleHasPermission', () => {
  it('a role always meets its own floor', () => {
    for (const role of ORDERED_HIGH_TO_LOW) {
      expect(meetsRoleFloor(role, role)).toBe(true);
    }
  });

  it('a higher role meets every lower floor; a lower role never meets a higher floor', () => {
    for (let i = 0; i < ORDERED_HIGH_TO_LOW.length; i += 1) {
      for (let j = 0; j < ORDERED_HIGH_TO_LOW.length; j += 1) {
        const userRole = ORDERED_HIGH_TO_LOW[i];
        const floor = ORDERED_HIGH_TO_LOW[j];
        // i <= j means userRole is the same or higher privilege than the floor.
        expect(meetsRoleFloor(userRole, floor)).toBe(i <= j);
      }
    }
  });

  it('MODULE_USER does NOT meet the MODULE_MANAGER floor (the harvest case)', () => {
    expect(meetsRoleFloor('MODULE_USER', 'MODULE_MANAGER')).toBe(false);
  });

  it('MODULE_MANAGER meets the MODULE_MANAGER floor', () => {
    expect(meetsRoleFloor('MODULE_MANAGER', 'MODULE_MANAGER')).toBe(true);
  });

  it('SUPER_ADMIN meets every floor', () => {
    for (const floor of ORDERED_HIGH_TO_LOW) {
      expect(meetsRoleFloor('SUPER_ADMIN', floor)).toBe(true);
    }
  });
});
