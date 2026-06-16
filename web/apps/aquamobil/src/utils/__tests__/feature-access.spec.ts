// SEC-MEDIUM-050 — feature access composes the entitlement flag AND the role floor.
//
// Harvest carries a MODULE_MANAGER floor (createHarvestRecord @Roles); other
// features have no floor and reduce to the entitlement check. A MODULE_USER with
// the harvest feature ON must STILL be denied harvest — the client gate must
// match the server @Roles so no after-success 403 is reachable.

import { describe, it, expect } from 'vitest';

import { featureRoleFloor, isFeatureAccessible } from '../feature-access';

import type { MobileFeature } from '@/hooks/useMobilePermissions';

const allow = (_f: MobileFeature): boolean => true;
const deny = (_f: MobileFeature): boolean => false;

describe('featureRoleFloor', () => {
  it('returns MODULE_MANAGER for harvest', () => {
    expect(featureRoleFloor('harvest')).toBe('MODULE_MANAGER');
  });

  it('returns undefined for features with no server role restriction', () => {
    expect(featureRoleFloor('mortality')).toBeUndefined();
    expect(featureRoleFloor('cull')).toBeUndefined();
    expect(featureRoleFloor('transfer')).toBeUndefined();
    expect(featureRoleFloor('feeding')).toBeUndefined();
  });
});

describe('isFeatureAccessible — harvest role floor', () => {
  it('denies harvest to a MODULE_USER even when the feature flag is ON', () => {
    expect(isFeatureAccessible(allow, 'harvest', 'MODULE_USER')).toBe(false);
  });

  it('allows harvest to a MODULE_MANAGER when the feature flag is ON', () => {
    expect(isFeatureAccessible(allow, 'harvest', 'MODULE_MANAGER')).toBe(true);
  });

  it('allows harvest to a TENANT_ADMIN / SUPER_ADMIN when the feature flag is ON', () => {
    expect(isFeatureAccessible(allow, 'harvest', 'TENANT_ADMIN')).toBe(true);
    expect(isFeatureAccessible(allow, 'harvest', 'SUPER_ADMIN')).toBe(true);
  });

  it('denies harvest when the feature flag is OFF regardless of role', () => {
    expect(isFeatureAccessible(deny, 'harvest', 'SUPER_ADMIN')).toBe(false);
    expect(isFeatureAccessible(deny, 'harvest', 'MODULE_MANAGER')).toBe(false);
  });

  it('FAILS CLOSED for harvest when role is undefined (no user)', () => {
    expect(isFeatureAccessible(allow, 'harvest', undefined)).toBe(false);
  });
});

describe('isFeatureAccessible — non-floored features', () => {
  it('reduces to the entitlement check for features without a floor', () => {
    // MODULE_USER with the flag ON passes; flag OFF fails. Role is irrelevant.
    expect(isFeatureAccessible(allow, 'mortality', 'MODULE_USER')).toBe(true);
    expect(isFeatureAccessible(deny, 'mortality', 'MODULE_USER')).toBe(false);
    expect(isFeatureAccessible(allow, 'cull', 'MODULE_USER')).toBe(true);
    expect(isFeatureAccessible(allow, 'transfer', 'MODULE_USER')).toBe(true);
  });

  it('allows a non-floored feature even when role is undefined (entitlement-only)', () => {
    expect(isFeatureAccessible(allow, 'mortality', undefined)).toBe(true);
  });
});
