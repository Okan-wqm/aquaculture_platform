import { clsx } from 'clsx';
import type { LucideIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import type { MobileFeature } from '@/hooks/useMobilePermissions';
import { useFeatureAccess } from '@/utils/feature-access';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QuickAction {
  feature: MobileFeature;
  path: string;
  icon: LucideIcon;
  label: string;
  gradient: string;
}

interface QuickActionGridProps {
  actions: QuickAction[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * QuickActionGrid -- 2-column RBAC-filtered action button grid.
 *
 * WHY permission filtering here: Each hub page defines a superset of possible
 * actions, but individual users may only have access to a subset. Filtering
 * at the grid level (rather than at the page level) keeps the page component
 * clean and makes the RBAC logic reusable across all 4 hub pages.
 *
 * WHY 2-column fixed grid: Field workers use the app one-handed on wet/cold
 * hands. Two columns provide large enough touch targets (~44% screen width)
 * while showing enough options to minimize scrolling. This matches the
 * existing OperationsHubPage card grid pattern.
 */
export function QuickActionGrid({ actions }: QuickActionGridProps): ReactElement | null {
  const navigate = useNavigate();
  // SEC-MEDIUM-050: canReach enforces the entitlement flag AND any feature role
  // floor (harvest => MODULE_MANAGER), so a sub-floor user never sees the action.
  const { canReach } = useFeatureAccess();

  const visibleActions = actions.filter((action) => canReach(action.feature));

  // WHY: Render nothing when no actions are visible. The parent hub page is
  // responsible for showing an appropriate empty state if ALL sections are
  // empty, since the empty state messaging varies per hub.
  if (visibleActions.length === 0) return null;

  return (
    <nav aria-label="Quick actions">
      <div className="grid grid-cols-2 gap-3">
        {visibleActions.map((action) => {
          const Icon = action.icon;
          return (
            <button
              key={action.path}
              onClick={() => navigate(action.path)}
              aria-label={action.label}
              className={clsx(
                'flex flex-col items-center justify-center p-5 rounded-2xl',
                'min-h-[44px] touch-feedback shadow-card transition-all',
                'motion-safe:active:scale-[0.97]',
                `bg-gradient-to-br ${action.gradient}`,
              )}
            >
              <Icon className="text-white mb-2.5" size={30} />
              <span className="text-xs font-bold text-white text-center leading-tight">
                {action.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export type { QuickAction };
