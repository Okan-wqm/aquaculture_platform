// ============================================================================
// Feature access SSoT (entitlement AND role floor) — SEC-MEDIUM-050
// ============================================================================
// WHY: a mobile feature is reachable only when TWO orthogonal gates hold — the
// per-user entitlement flag (auth.mobile_user_settings.allowedFeatures, read via
// useMobilePermissions.canAccess) AND, for operations the backend restricts by
// role, a role floor matching that resolver's @Roles matrix. Harvest is the
// concrete case: createHarvestRecord is @Roles(TENANT_ADMIN, MODULE_MANAGER) but
// its feature flag defaults TRUE for everyone, so a MODULE_USER would pass the
// feature gate, reach the form, submit, and only THEN get a 403. The role floor
// must travel WITH the feature so EVERY entry point (route + every CTA) enforces
// it identically.
//
// WHAT: a declarative feature -> required-role-floor map, plus a single
// `isFeatureAccessible` predicate composing the entitlement check with the floor
// via the shared meetsRoleFloor SSoT. Adding/removing a role floor for any
// feature is a one-line change here that the route guard AND all CTAs honor
// automatically — no per-callsite string comparison, no drift.

import { useCallback } from 'react';

import { useAuth } from '@/hooks/useAuth';
import { useMobilePermissions, type MobileFeature } from '@/hooks/useMobilePermissions';
import type { Role } from '@/types';
import { meetsRoleFloor } from '@/utils/role-rank';

// Features whose backend resolver restricts the operation by role. The floor
// MUST mirror the server @Roles matrix so the client never surfaces an action
// the server will reject. Harvest === createHarvestRecord (MODULE_MANAGER+).
const FEATURE_ROLE_FLOOR: Partial<Record<MobileFeature, Role>> = {
  harvest: 'MODULE_MANAGER',
  // FARM-HIGH-214: report drafts are reviewed/approved by managers only —
  // mirrors @Roles(TENANT_ADMIN, MODULE_MANAGER) on RegulatoryReportDraftResolver.
  reports: 'MODULE_MANAGER',
};

/**
 * Role floor required to use a feature, or undefined when the feature has no
 * server-side role restriction beyond the entitlement flag.
 */
export function featureRoleFloor(feature: MobileFeature): Role | undefined {
  return FEATURE_ROLE_FLOOR[feature];
}

/**
 * True when the user may reach `feature`: entitled (canAccess) AND, when the
 * feature carries a role floor, holding that floor or higher.
 *
 * FAIL-CLOSED: a missing role (no authenticated user) fails any role-floored
 * feature. Features with no floor reduce to the plain entitlement check.
 */
export function isFeatureAccessible(
  canAccess: (feature: MobileFeature) => boolean,
  feature: MobileFeature,
  role: Role | undefined,
): boolean {
  if (!canAccess(feature)) {
    return false;
  }
  const floor = FEATURE_ROLE_FLOOR[feature];
  if (!floor) {
    return true;
  }
  return role != null && meetsRoleFloor(role, floor);
}

/**
 * Hook returning a `canReach(feature)` predicate bound to the current user's
 * role — the entitlement-AND-role-floor SSoT for UI entry points (CTAs, route
 * filters). Callsites swap a bare `canAccess(feature)` for `canReach(feature)`
 * with no role plumbing, so every harvest CTA enforces the MODULE_MANAGER floor
 * identically to the route guard and the backend @Roles matrix.
 */
export function useFeatureAccess(): { canReach: (feature: MobileFeature) => boolean } {
  const { canAccess } = useMobilePermissions();
  const { user } = useAuth();
  const role = user?.role;

  const canReach = useCallback(
    (feature: MobileFeature): boolean => isFeatureAccessible(canAccess, feature, role),
    [canAccess, role],
  );

  return { canReach };
}
