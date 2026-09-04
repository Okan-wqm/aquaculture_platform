import type { ReactNode } from 'react';
import { Badge } from '../../design/Badge.tsx';
import { Stat } from '../../design/Stat.tsx';
import { formatNumber } from '../../design/format.ts';
import { toneForSeverity, toneForStatus } from './tones.ts';

export interface ByCountStatsProps {
  readonly counts: Readonly<Record<string, number>>;
  readonly kind: 'status' | 'severity';
  readonly emptyMessage: string;
}

/** Renders a `Record<string, number>` (byStatus / bySeverity / byState) as KPI tiles with verbatim keys. */
export function ByCountStats({ counts, kind, emptyMessage }: ByCountStatsProps): ReactNode {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return <p className="muted">{emptyMessage}</p>;
  }
  return (
    <div className="stat-grid">
      {entries.map(([key, count]) => (
        <Stat
          key={key}
          label={key}
          value={formatNumber(count)}
          hint={<Badge tone={kind === 'severity' ? toneForSeverity(key) : toneForStatus(key)}>{key}</Badge>}
        />
      ))}
    </div>
  );
}
