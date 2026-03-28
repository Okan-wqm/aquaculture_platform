import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ClipboardList,
  MapPin,
  Skull,
  Droplets,
  Utensils,
  Scissors,
  Package,
  ArrowLeftRight,
  Warehouse,
  CalendarOff,
  Calendar,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useMobilePermissions, type MobileFeature } from '@/hooks/useMobilePermissions';
import { clsx } from 'clsx';

/**
 * OperationsHubPage — Grouped mobile operations organized by workflow category.
 *
 * Operations are grouped into 4 categories that reflect the natural workflow
 * of aquaculture field workers:
 * - Daily Operations: shift-start tasks in chronological order
 * - Stock Events: scheduled batch lifecycle operations
 * - Warehouse: inventory and supply chain operations
 * - Staff: HR self-service (attendance, leave, schedule)
 *
 * Each group auto-hides if the current user has no permissions for any
 * operation within it. This keeps the UI clean for restricted roles
 * (e.g., a warehouse worker sees only Warehouse + Staff groups).
 *
 * Enterprise pattern: AKVA Group FiizK uses a similar grouped approach.
 * The ordering within "Daily Operations" follows the actual shift sequence:
 * Clock In -> Mortality Check -> Water Quality -> Feeding (not alphabetical).
 */

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/** A single actionable operation card within a group. */
interface OperationItem {
  /** Permission feature key checked via useMobilePermissions().canAccess() */
  feature: MobileFeature;
  /** Navigation target within the mobile app */
  path: string;
  /** Lucide icon component rendered inside the card */
  icon: LucideIcon;
  /** User-facing label displayed below the icon */
  label: string;
  /** Tailwind gradient classes for the card background */
  gradient: string;
}

/** A logical grouping of operations with its own header styling. */
interface OperationGroup {
  /** Unique identifier used as React key */
  id: string;
  /** Display title shown in the group header bar */
  title: string;
  /** Tailwind gradient classes for the section header */
  headerGradient: string;
  /** Operations belonging to this group (pre-filtered by permissions at render) */
  items: OperationItem[];
}

// ---------------------------------------------------------------------------
// Static group definitions
// ---------------------------------------------------------------------------

/**
 * WHY shift-sequence ordering in Daily Operations:
 * Field workers follow a consistent morning routine — arrive at the farm,
 * clock in, walk the pens to check for mortalities, take water quality
 * readings, then begin the feeding cycle. Ordering the buttons in this
 * natural sequence reduces cognitive load and missed steps. The other
 * groups are ordered by frequency of use within their category.
 */
const OPERATION_GROUPS: OperationGroup[] = [
  {
    id: 'daily',
    title: 'Daily Operations',
    headerGradient: 'from-orange-500 to-amber-500',
    items: [
      {
        feature: 'attendance',
        path: '/attendance',
        icon: MapPin,
        label: 'Clock In',
        gradient: 'from-emerald-500 to-emerald-600',
      },
      {
        feature: 'mortality',
        path: '/mortality/record',
        icon: Skull,
        label: 'Mortality Check',
        gradient: 'from-red-500 to-red-600',
      },
      {
        feature: 'waterQuality',
        path: '/water-quality/record',
        icon: Droplets,
        label: 'Water Quality',
        gradient: 'from-cyan-500 to-cyan-600',
      },
      {
        feature: 'feeding',
        path: '/feeding/record',
        icon: Utensils,
        label: 'Feeding',
        gradient: 'from-green-500 to-green-600',
      },
    ],
  },
  {
    id: 'stock',
    title: 'Stock Events',
    headerGradient: 'from-purple-500 to-violet-500',
    items: [
      {
        feature: 'cull',
        path: '/cull/record',
        icon: Scissors,
        label: 'Culling',
        gradient: 'from-amber-500 to-amber-600',
      },
      {
        feature: 'harvest',
        path: '/harvest/record',
        icon: Package,
        label: 'Harvest',
        gradient: 'from-violet-500 to-violet-600',
      },
      {
        feature: 'transfer',
        path: '/transfer/record',
        icon: ArrowLeftRight,
        label: 'Transfer',
        gradient: 'from-blue-500 to-blue-600',
      },
    ],
  },
  {
    id: 'warehouse',
    title: 'Warehouse',
    headerGradient: 'from-teal-500 to-teal-600',
    items: [
      {
        feature: 'storage',
        path: '/storage',
        icon: Warehouse,
        label: 'Storage',
        gradient: 'from-teal-500 to-teal-600',
      },
    ],
  },
  {
    id: 'staff',
    title: 'Staff',
    headerGradient: 'from-indigo-500 to-indigo-600',
    items: [
      {
        feature: 'leave',
        path: '/leave',
        icon: CalendarOff,
        label: 'Leave Request',
        gradient: 'from-indigo-500 to-indigo-600',
      },
      {
        feature: 'schedule',
        path: '/schedule',
        icon: Calendar,
        label: 'My Schedule',
        gradient: 'from-sky-500 to-sky-600',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OperationsHubPage() {
  const navigate = useNavigate();
  const { canAccess } = useMobilePermissions();

  /**
   * Two-pass filter:
   * 1. Remove individual items the user cannot access (RBAC per-feature).
   * 2. Remove entire groups that have zero visible items afterwards.
   *
   * This ensures a warehouse-only worker sees just the Warehouse + Staff
   * groups instead of empty section headers for Daily Ops / Stock Events.
   */
  const visibleGroups = useMemo(() => {
    return OPERATION_GROUPS
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => canAccess(item.feature)),
      }))
      .filter((group) => group.items.length > 0);
  }, [canAccess]);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Page header — gradient banner matching the existing app design system */}
      <div className="bg-gradient-to-br from-ocean-700 via-ocean-600 to-ocean-500 text-white">
        <div className="px-5 pt-safe-top">
          <div className="flex items-center gap-3 py-4">
            <div className="w-10 h-10 bg-white/15 backdrop-blur-sm rounded-xl flex items-center justify-center">
              <ClipboardList size={22} className="text-white" />
            </div>
            <h1 className="text-lg font-bold tracking-tight">Operations</h1>
          </div>
        </div>
        {/* Curved bottom edge — consistent with HomePage and RecordHubPage */}
        <div className="relative">
          <svg viewBox="0 0 400 20" fill="none" className="w-full block" preserveAspectRatio="none">
            <path d="M0 20V0c100 15 200 15 400 0v20z" className="fill-gray-50 dark:fill-gray-950" />
          </svg>
        </div>
      </div>

      {/* Operation groups */}
      <div className="px-5 pt-4 space-y-6">
        {visibleGroups.length > 0 ? (
          visibleGroups.map((group) => (
            <section key={group.id}>
              {/* Group header — gradient pill with title */}
              <div
                className={clsx(
                  'bg-gradient-to-r rounded-xl px-4 py-2.5 mb-3',
                  group.headerGradient,
                )}
              >
                <h2 className="text-sm font-bold text-white uppercase tracking-wider">
                  {group.title}
                </h2>
              </div>

              {/* 2-column card grid for the group's visible items */}
              <div className="grid grid-cols-2 gap-3">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.feature}
                      onClick={() => navigate(item.path)}
                      className={clsx(
                        'flex flex-col items-center justify-center p-5 rounded-2xl',
                        'touch-feedback shadow-card transition-all active:scale-[0.97]',
                        `bg-gradient-to-br ${item.gradient}`,
                      )}
                    >
                      <Icon className="text-white mb-2.5" size={30} />
                      <span className="text-xs font-bold text-white text-center leading-tight">
                        {item.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))
        ) : (
          /* Empty state — shown when user has no permissions for any operation */
          <div className="text-center py-12 text-gray-400">
            <ClipboardList size={48} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">No operations available</p>
            <p className="text-sm mt-1">Contact your administrator for access</p>
          </div>
        )}
      </div>

      {/* Bottom spacer to prevent content from hiding behind the fixed tab bar */}
      <div className="h-24" />
    </div>
  );
}
