import { clsx } from 'clsx';
import { Utensils, Skull, Scissors, Package, ArrowLeftRight, Bug, ClipboardList, Droplets, FileText, HeartPulse, TriangleAlert, Warehouse } from 'lucide-react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { type MobileFeature } from '@/hooks/useMobilePermissions';
import { useFeatureAccess } from '@/utils/feature-access';

interface RecordAction {
  feature: MobileFeature;
  path: string;
  icon: typeof Skull;
  label: string;
  gradient: string;
}

const allActions: RecordAction[] = [
  { feature: 'feeding', path: '/feeding/record', icon: Utensils, label: 'Feeding', gradient: 'from-orange-500 to-orange-600' },
  { feature: 'waterQuality', path: '/water-quality/record', icon: Droplets, label: 'Water Quality', gradient: 'from-cyan-500 to-blue-500' },
  { feature: 'mortality', path: '/mortality/record', icon: Skull, label: 'Mortality Record', gradient: 'from-red-500 to-red-600' },
  { feature: 'cull', path: '/cull/record', icon: Scissors, label: 'Culling', gradient: 'from-amber-500 to-amber-600' },
  { feature: 'harvest', path: '/harvest/record', icon: Package, label: 'Harvest', gradient: 'from-green-500 to-green-600' },
  { feature: 'transfer', path: '/transfer/record', icon: ArrowLeftRight, label: 'Transfer', gradient: 'from-blue-500 to-blue-600' },
  { feature: 'storage', path: '/storage', icon: Warehouse, label: 'Storage', gradient: 'from-teal-500 to-teal-600' },
  // FARM-HIGH-214 (RPT-019): regulatory field capture + the reports-due surface.
  { feature: 'liceCount', path: '/lice/record', icon: Bug, label: 'Lice Count', gradient: 'from-violet-500 to-violet-600' },
  { feature: 'welfare', path: '/welfare/record', icon: HeartPulse, label: 'Welfare Scores', gradient: 'from-emerald-500 to-emerald-600' },
  { feature: 'escape', path: '/escape/record', icon: TriangleAlert, label: 'Escape Incident', gradient: 'from-orange-500 to-amber-600' },
  { feature: 'reports', path: '/reports', icon: FileText, label: 'Reports Due', gradient: 'from-indigo-500 to-indigo-600' },
];

export function RecordHubPage(): JSX.Element {
  const navigate = useNavigate();
  // SEC-MEDIUM-050: canReach enforces the harvest MODULE_MANAGER role floor too.
  const { canReach } = useFeatureAccess();

  const visibleActions = allActions.filter((a) => canReach(a.feature));

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <div className="bg-gradient-to-br from-ocean-700 via-ocean-600 to-ocean-500 text-white">
        <div className="px-5 pt-safe-top">
          <div className="flex items-center gap-3 py-4">
            <div className="w-10 h-10 bg-white/15 backdrop-blur-sm rounded-xl flex items-center justify-center">
              <ClipboardList size={22} className="text-white" />
            </div>
            <h1 className="text-lg font-bold tracking-tight">Record Operations</h1>
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
        {visibleActions.length > 0 ? (
          <div className="grid grid-cols-2 gap-4">
            {visibleActions.map((action) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.feature}
                  onClick={() => navigate(action.path)}
                  className={clsx(
                    'flex flex-col items-center justify-center p-6 rounded-2xl touch-feedback shadow-card transition-all active:scale-[0.97]',
                    `bg-gradient-to-br ${action.gradient}`,
                  )}
                >
                  <Icon className="text-white mb-3" size={32} />
                  <span className="text-sm font-bold text-white">{action.label}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-12 text-gray-400">
            <ClipboardList size={48} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">You do not have access</p>
          </div>
        )}
      </div>

      {/* Bottom spacer for tab bar */}
      <div className="h-24" />
    </div>
  );
}
