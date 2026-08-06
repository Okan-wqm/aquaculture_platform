import type { ReactElement, ReactNode } from 'react';
import { Navigate } from 'react-router-dom';

import { useMobilePermissions, type MobileFeature } from '@/hooks/useMobilePermissions';
import { useFeatureAccess } from '@/utils/feature-access';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MultiFeatureRouteProps {
  features: MobileFeature[];
  children: ReactNode;
}

// ---------------------------------------------------------------------------
// Loading fallback — matches the PageLoader pattern from App.tsx
// ---------------------------------------------------------------------------

function PageLoader(): ReactElement {
  return (
    <div className="flex items-center justify-center min-h-[50vh]">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-acc" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * MultiFeatureRoute -- route guard for hub pages that span multiple features.
 *
 * WHY: Hub pages like DailyOpsHub aggregate data from several feature domains
 * (attendance, mortality, waterQuality, feeding). A user who has access to
 * ANY one of those features should be allowed into the hub -- they will see
 * only the sections their permissions allow. Using `.every()` would block a
 * feeding-only worker from the daily ops hub entirely, defeating the purpose
 * of the grouped layout.
 *
 * WHY redirect to /operations: Hub pages are children of the Operations tab.
 * Redirecting to the operations hub (not /) keeps the user in the correct
 * navigation context and avoids a confusing jump to the home screen.
 */
export function MultiFeatureRoute({ features, children }: MultiFeatureRouteProps): ReactElement {
  const { isLoaded } = useMobilePermissions();
  // SEC-MEDIUM-050: canReach folds in any feature role floor (harvest =>
  // MODULE_MANAGER), so a harvest-only MODULE_USER cannot enter a hub on the
  // strength of harvest alone — consistent with the per-action CTA filtering.
  const { canReach } = useFeatureAccess();

  // WHY: Wait for permissions to resolve before evaluating access. Without
  // this guard, a slow network would cause a flash redirect to /operations
  // before the user's actual permissions arrive from the server/cache.
  if (!isLoaded) {
    return <PageLoader />;
  }

  // CRITICAL: `.some()` not `.every()` -- grant access if the user can
  // reach ANY of the listed features.
  const hasAnyFeature = features.some((f) => canReach(f));

  if (!hasAnyFeature) {
    return <Navigate to="/operations" replace />;
  }

  return <>{children}</>;
}
