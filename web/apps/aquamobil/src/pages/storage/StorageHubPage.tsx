/**
 * StorageHubPage -- Mobile warehouse operations hub.
 *
 * Provides quick-access cards for the 5 most common warehouse floor operations.
 * Each card navigates to a focused single-purpose form optimized for one-handed
 * mobile use with large touch targets. This is where warehouse workers start
 * their daily operations: receiving deliveries (IN), dispensing feed/chemicals
 * (OUT), transferring between locations, writing off waste, or checking stock.
 */

import { useNavigate } from 'react-router-dom';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowLeftRight,
  Trash2,
  Package,
  Warehouse,
} from 'lucide-react';
import { useMobilePermissions } from '@/hooks/useMobilePermissions';
import { clsx } from 'clsx';

interface StorageAction {
  id: string;
  path: string;
  icon: typeof Package;
  label: string;
  description: string;
  gradient: string;
}

// WHY: Five core warehouse operations cover 95%+ of daily warehouse floor activity.
// Each navigates to a purpose-built form rather than a multi-purpose screen, reducing
// cognitive load and error rates for workers wearing gloves or in wet environments.
const storageActions: StorageAction[] = [
  {
    id: 'stock-in',
    path: '/storage/movement?type=IN',
    icon: ArrowDownToLine,
    label: 'Stock In',
    description: 'Receive deliveries',
    gradient: 'from-green-500 to-green-600',
  },
  {
    id: 'stock-out',
    path: '/storage/movement?type=OUT',
    icon: ArrowUpFromLine,
    label: 'Stock Out',
    description: 'Dispense items',
    gradient: 'from-red-500 to-red-600',
  },
  {
    id: 'transfer',
    path: '/storage/transfer',
    icon: ArrowLeftRight,
    label: 'Transfer',
    description: 'Move between locations',
    gradient: 'from-blue-500 to-blue-600',
  },
  {
    id: 'write-off',
    path: '/storage/movement?type=WASTE',
    icon: Trash2,
    label: 'Write Off',
    description: 'Record waste/loss',
    gradient: 'from-gray-500 to-gray-600',
  },
  {
    id: 'view-stock',
    path: '/storage/view',
    icon: Package,
    label: 'View Stock',
    description: 'Check inventory',
    gradient: 'from-cyan-500 to-cyan-600',
  },
];

export function StorageHubPage() {
  const navigate = useNavigate();
  const { canAccess } = useMobilePermissions();

  // WHY: Early exit if the user lost storage access mid-session (e.g., admin revoked
  // permissions while the app was open). The FeatureRoute guard catches most cases,
  // but this provides defense-in-depth for direct URL navigation.
  const hasAccess = canAccess('storage');

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header -- follows the gradient header pattern from RecordHubPage */}
      <div className="bg-gradient-to-br from-teal-700 via-teal-600 to-teal-500 text-white">
        <div className="px-5 pt-safe-top">
          <div className="flex items-center gap-3 py-4">
            <div className="w-10 h-10 bg-white/15 backdrop-blur-sm rounded-xl flex items-center justify-center">
              <Warehouse size={22} className="text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">Storage Operations</h1>
              <p className="text-xs text-white/80">Warehouse management</p>
            </div>
          </div>
        </div>
        <div className="relative">
          <svg viewBox="0 0 400 20" fill="none" className="w-full block" preserveAspectRatio="none">
            <path d="M0 20V0c100 15 200 15 400 0v20z" className="fill-gray-50 dark:fill-gray-950" />
          </svg>
        </div>
      </div>

      {/* Grid of operation cards */}
      <div className="px-5 pt-4">
        {hasAccess ? (
          <div className="grid grid-cols-2 gap-4">
            {storageActions.map((action) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.id}
                  onClick={() => navigate(action.path)}
                  className={clsx(
                    'flex flex-col items-center justify-center p-6 rounded-2xl touch-feedback shadow-card transition-all active:scale-[0.97]',
                    `bg-gradient-to-br ${action.gradient}`,
                  )}
                >
                  <Icon className="text-white mb-3" size={32} />
                  <span className="text-sm font-bold text-white">{action.label}</span>
                  <span className="text-xs text-white/70 mt-0.5">{action.description}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-12 text-gray-400">
            <Warehouse size={48} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">You do not have access</p>
          </div>
        )}
      </div>

      {/* Bottom spacer for tab bar */}
      <div className="h-24" />
    </div>
  );
}
