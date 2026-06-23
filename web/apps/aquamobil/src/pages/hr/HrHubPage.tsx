import { clsx } from 'clsx';
import { MapPin, CalendarOff, Clock, Users } from 'lucide-react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { useMobilePermissions, type MobileFeature } from '@/hooks/useMobilePermissions';


interface HrCard {
  feature: MobileFeature;
  path: string;
  icon: typeof MapPin;
  label: string;
  description: string;
  gradient: string;
  iconBg: string;
}

const hrCards: HrCard[] = [
  {
    feature: 'attendance',
    path: '/attendance',
    icon: MapPin,
    label: 'Attendance',
    description: 'Clock in/out',
    gradient: 'from-green-500 to-green-600',
    iconBg: 'bg-green-100 dark:bg-green-900/30',
  },
  {
    feature: 'leave',
    path: '/leave',
    icon: CalendarOff,
    label: 'Leave',
    description: 'Leave request and balance',
    gradient: 'from-blue-500 to-blue-600',
    iconBg: 'bg-blue-100 dark:bg-blue-900/30',
  },
  {
    feature: 'schedule',
    path: '/schedule',
    icon: Clock,
    label: 'Shift',
    description: 'Shift schedule',
    gradient: 'from-purple-500 to-purple-600',
    iconBg: 'bg-purple-100 dark:bg-purple-900/30',
  },
];

export function HrHubPage(): JSX.Element {
  const navigate = useNavigate();
  const { canAccess } = useMobilePermissions();

  const visibleCards = hrCards.filter((c) => canAccess(c.feature));

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <div className="bg-gradient-to-br from-ocean-700 via-ocean-600 to-ocean-500 text-white">
        <div className="px-5 pt-safe-top">
          <div className="flex items-center gap-3 py-4">
            <div className="w-10 h-10 bg-white/15 backdrop-blur-sm rounded-xl flex items-center justify-center">
              <Users size={22} className="text-white" />
            </div>
            <h1 className="text-lg font-bold tracking-tight">HR Operations</h1>
          </div>
        </div>
        <div className="relative">
          <svg viewBox="0 0 400 20" fill="none" className="w-full block" preserveAspectRatio="none">
            <path d="M0 20V0c100 15 200 15 400 0v20z" className="fill-gray-50 dark:fill-gray-950" />
          </svg>
        </div>
      </div>

      {/* Cards */}
      <div className="px-5 pt-4 space-y-4">
        {visibleCards.length > 0 ? (
          visibleCards.map((card) => {
            const Icon = card.icon;
            return (
              <button
                key={card.feature}
                onClick={() => navigate(card.path)}
                className="w-full bg-white dark:bg-gray-900 rounded-2xl shadow-card overflow-hidden border border-gray-100 dark:border-gray-800 text-left touch-feedback transition-all active:scale-[0.98]"
              >
                <div className="flex items-center p-5 gap-4">
                  <div className={clsx('w-14 h-14 rounded-2xl flex items-center justify-center', card.iconBg)}>
                    <Icon size={28} className={clsx(
                      card.feature === 'attendance' && 'text-green-600',
                      card.feature === 'leave' && 'text-blue-600',
                      card.feature === 'schedule' && 'text-purple-600',
                    )} />
                  </div>
                  <div className="flex-1">
                    <h3 className="font-bold text-gray-900 dark:text-white text-[16px]">{card.label}</h3>
                    <p className="text-sm text-gray-500 mt-0.5">{card.description}</p>
                  </div>
                  <div className="text-gray-300 dark:text-gray-600">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </div>
                </div>
              </button>
            );
          })
        ) : (
          <div className="text-center py-12 text-gray-400">
            <Users size={48} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">You do not have access</p>
          </div>
        )}
      </div>

      {/* Bottom spacer for tab bar */}
      <div className="h-24" />
    </div>
  );
}
