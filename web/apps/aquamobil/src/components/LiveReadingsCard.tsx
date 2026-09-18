import { Waves } from 'lucide-react';
import type { ReactElement } from 'react';

import { DataFreshness } from './DataFreshness';

import { useLatestReadings } from '@/hooks/useLatestReadings';

/**
 * MOB-MEDIUM-008: the live water-values card for a tank. Every value carries
 * its own DataFreshness stamp — a number without an age is not actionable in
 * the field. Renders an explicit "no sensors" state so a sensorless tank never
 * looks like a healthy one, and hides nothing behind spinners when offline
 * (the hook serves last-known values with their honest, old timestamps).
 */
export function LiveReadingsCard({ tankId }: { tankId: string }): ReactElement | null {
  const { metrics, hasSensors, isLoading, error } = useLatestReadings(tankId);

  if (isLoading) {
    return <div className="h-24 rounded-2xl bg-gray-200 dark:bg-gray-800 animate-pulse" />;
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card border border-gray-100 dark:border-gray-800 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Waves size={16} className="text-ocean-500" />
        <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">Live Water Values</h3>
      </div>

      {!hasSensors && !error && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No sensors are registered for this tank.
        </p>
      )}

      {error && metrics.length === 0 && (
        <p className="text-sm text-red-600 dark:text-red-400">Live values unavailable: {error}</p>
      )}

      {hasSensors && metrics.length === 0 && !error && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Sensors registered, but no readings have arrived yet.
        </p>
      )}

      {metrics.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          {metrics.map((metric) => (
            <div
              key={metric.key}
              className="rounded-xl bg-gray-50 dark:bg-gray-800/60 p-2.5 text-center"
            >
              <div className="text-lg font-bold tabular-nums text-gray-900 dark:text-gray-100">
                {metric.value}
                {metric.unit && (
                  <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 ml-0.5">
                    {metric.unit}
                  </span>
                )}
              </div>
              <div className="text-[11px] font-semibold text-gray-500 dark:text-gray-400">
                {metric.label}
              </div>
              <DataFreshness timestamp={metric.readingAt} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
