import React from 'react';

import { useAuth } from '@/hooks/useAuth';

/**
 * IdentityBoundary — defense-in-depth for shared-device tenant isolation
 * (MT-CRITICAL-050).
 *
 * WHY: the awaited logout wipe in useAuth.logout is the PRIMARY barrier. This is
 * the second barrier: keying the authenticated subtree by the active identity
 * `${tenantId}:${userId}` forces React to UNMOUNT the entire prior-user subtree
 * and MOUNT a fresh one whenever the identity changes (logout → next login on
 * the same device). No component state, ref, in-flight effect, or memoised value
 * belonging to user A can survive into user B's session — even if a future change
 * regressed the explicit cache wipe, a stale React subtree cannot leak across an
 * identity switch. When logged out (no user) the key is a stable sentinel so the
 * public/login tree is not needlessly remounted.
 */
export function IdentityBoundary({ children }: { children: React.ReactNode }): React.ReactElement {
  const { user, tenantId } = useAuth();
  const identityKey = user ? `${tenantId ?? 'no-tenant'}:${user.id}` : 'anonymous';
  return <React.Fragment key={identityKey}>{children}</React.Fragment>;
}
