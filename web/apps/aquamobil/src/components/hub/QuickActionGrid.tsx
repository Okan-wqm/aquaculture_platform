import type { LucideIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import type { RowTone } from '@/components/ui';
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
  /**
   * The hue the tile's icon wears. Log types get their own colour because a
   * worker recognises the entry they want before reading the label; everything
   * else is the accent. Defaults to `accent`.
   */
  tone?: RowTone;
}

interface QuickActionGridProps {
  actions: QuickAction[];
}

/**
 * Icon hue per tone — the only colour a tile carries. Same vocabulary as the
 * Today screen's shortcut grid, so an action looks the same wherever it is
 * reached from.
 */
const ACTION_ICON_CLASS: Record<RowTone, string> = {
  neutral: 'text-ink-3',
  accent: 'text-acc',
  warn: 'text-warn',
  crit: 'text-crit',
  ok: 'text-ok',
  feeding: 'text-type-feeding',
  mortality: 'text-type-mortality',
  water: 'text-type-water',
  cull: 'text-type-cull',
  transfer: 'text-type-transfer',
  harvest: 'text-type-harvest',
};

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
 * while showing enough options to minimize scrolling.
 *
 * v4: each tile used to carry its own two-stop gradient with a white icon and a
 * white label, so four tiles meant four competing colours and an alarm on the
 * same screen had nothing left to be louder than. Tiles now sit on the surface
 * and carry only the action's hue on the icon — the `gradient` prop is gone.
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
      <div className="grid grid-cols-2 gap-2">
        {visibleActions.map((action) => {
          const Icon = action.icon;
          return (
            <button
              key={action.path}
              type="button"
              onClick={() => navigate(action.path)}
              aria-label={action.label}
              className="min-h-touch p-4 rounded-2xl border border-line bg-surface-1 shadow-token flex flex-col items-center justify-center gap-2 touch-feedback motion-safe:active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc"
            >
              <Icon className={ACTION_ICON_CLASS[action.tone ?? 'accent']} size={24} />
              <span className="text-meta font-semibold text-ink-2 text-center leading-tight">
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
