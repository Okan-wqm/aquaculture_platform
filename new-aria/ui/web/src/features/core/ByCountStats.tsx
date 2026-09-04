import type { ReactNode } from 'react';
import { EmptyBlock } from '../../design/AsyncState.tsx';
import { Stat } from '../../design/Stat.tsx';
import { formatNumber } from '../../design/format.ts';
import { statToneForBadgeTone, toneForSeverity, toneForStatus } from './tones.ts';

export interface ByCountStatsProps {
  readonly counts: Readonly<Record<string, number>>;
  readonly kind: 'status' | 'severity';
  /** One sentence: what would appear here, and why it is empty. */
  readonly emptyMessage: string;
  readonly emptyTitle?: string | undefined;
}

/**
 * Renders a `Record<string, number>` (byStatus / bySeverity / byState) as tiles.
 *
 * WHY: the distribution is the first question an operator asks of a ledger view
 * ("how much of this is on fire?"), so it sits above the table. WHAT: every key
 * is a kernel value and renders verbatim as the tile label; the tile is tinted
 * by the same rule that tints its badge elsewhere, and tiles are ordered by
 * count so the largest bucket reads first.
 */
export function ByCountStats({ counts, kind, emptyMessage, emptyTitle }: ByCountStatsProps): ReactNode {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return <EmptyBlock title={emptyTitle} message={emptyMessage} flush />;
  }
  return (
    <div className="stat-grid">
      {entries.map(([key, count]) => (
        <Stat key={key} label={key} value={formatNumber(count)} tone={statToneForBadgeTone(kind === 'severity' ? toneForSeverity(key) : toneForStatus(key))} />
      ))}
    </div>
  );
}
