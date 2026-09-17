import { Antenna, Waves, WifiOff } from 'lucide-react';
import type { ReactElement } from 'react';

import { DataFreshness } from './DataFreshness';

import { Card, EmptyState, Skeleton } from '@/components/ui';
import { useLatestReadings } from '@/hooks/useLatestReadings';

/**
 * MOB-MEDIUM-008: the live water-values card for a tank. Every value carries
 * its own DataFreshness stamp — a number without an age is not actionable in
 * the field. Renders an explicit "no sensors" state so a sensorless tank never
 * looks like a healthy one, and hides nothing behind spinners when offline
 * (the hook serves last-known values with their honest, old timestamps).
 *
 * v4 keeps all THREE non-value states apart, because they mean different
 * things and a single grey shrug would flatten them:
 *   - no sensors registered  — a configuration fact about this tank
 *   - sensors but no readings — registered hardware that has never reported
 *   - the fetch failed        — tone="error", so "we don't know" can never be
 *     mistaken for "there is nothing to know"
 */
export function LiveReadingsCard({ tankId }: { tankId: string }): ReactElement | null {
  const { metrics, hasSensors, isLoading, error } = useLatestReadings(tankId);

  if (isLoading) {
    return <Skeleton variant="tile" />;
  }

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <Waves size={16} className="text-acc" />
        <h3 className="text-title font-semibold text-ink-1">Live Water Values</h3>
      </div>

      {!hasSensors && !error && (
        <EmptyState
          icon={<Antenna size={22} />}
          title="No sensors"
          description="No sensors are registered for this tank."
          className="py-4 px-0"
        />
      )}

      {error && metrics.length === 0 && (
        <EmptyState
          tone="error"
          icon={<WifiOff size={22} />}
          title="Live values unavailable"
          description={error}
          className="py-4 px-0"
        />
      )}

      {hasSensors && metrics.length === 0 && !error && (
        <EmptyState
          icon={<Waves size={22} />}
          title="No readings yet"
          description="Sensors are registered, but no readings have arrived yet."
          className="py-4 px-0"
        />
      )}

      {metrics.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          {metrics.map((metric) => (
            <div key={metric.key} className="rounded-xl bg-surface-2 p-2.5 text-center">
              <div className="text-head font-mono font-bold tabular-nums text-ink-1">
                {metric.value}
                {metric.unit && (
                  <span className="text-meta font-semibold text-ink-3 ml-0.5">{metric.unit}</span>
                )}
              </div>
              <div className="text-meta font-semibold text-ink-2">{metric.label}</div>
              {/* The per-value age stamp — this is what makes the number
                  actionable, so it stays attached to the value it dates. */}
              <DataFreshness timestamp={metric.readingAt} />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
