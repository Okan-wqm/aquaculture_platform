import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useMobilePermissions, type MobileFeature } from '@/hooks/useMobilePermissions';

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

function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-[50vh]">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-aqua-500" />
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
export function MultiFeatureRoute({ features, children }: MultiFeatureRouteProps) {
  const { canAccess, isLoaded } = useMobilePermissions();

  // WHY: Wait for permissions to resolve before evaluating access. Without
  // this guard, a slow network would cause a flash redirect to /operations
  // before the user's actual permissions arrive from the server/cache.
  if (!isLoaded) {
    return <PageLoader />;
  }

  // CRITICAL: `.some()` not `.every()` -- grant access if the user can
  // reach ANY of the listed features.
  const hasAnyFeature = features.some((f) => canAccess(f));

  if (!hasAnyFeature) {
    return <Navigate to="/operations" replace />;
  }

  return <>{children}</>;
}
