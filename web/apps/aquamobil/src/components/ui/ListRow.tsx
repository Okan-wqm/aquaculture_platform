/**
 * ListRow — the v4 list item: coloured icon tile, title + subtitle, trailing
 * value, optional chevron.
 *
 * This one shape carries the alarms list, the task list, the unit list, the
 * recent-entries list and the channel list. Each of those was previously written
 * from scratch on its page, which is why the same row had three different
 * heights and two different chevron sizes in the pre-v4 app.
 *
 * `tone` drives the icon tile only. Per-log-type colour coding is the one place
 * v4 lets colour be decorative, because a field worker identifies an entry type
 * by hue before reading a word of it.
 */
import { clsx } from 'clsx';
import { ChevronRight } from 'lucide-react';
import { type ReactElement, type ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

/** Log types get their own hue; the semantic tones cover everything else. */
export type RowTone =
  | 'neutral'
  | 'accent'
  | 'warn'
  | 'crit'
  | 'ok'
  | 'feeding'
  | 'mortality'
  | 'water'
  | 'cull'
  | 'transfer'
  | 'harvest';

const TILE_CLASS: Record<RowTone, string> = {
  neutral: 'bg-surface-2 text-ink-2',
  accent: 'bg-acc-dim text-acc',
  warn: 'bg-warn-dim text-warn',
  crit: 'bg-crit-dim text-crit',
  ok: 'bg-surface-2 text-ok',
  feeding: 'bg-type-feeding-dim text-type-feeding',
  mortality: 'bg-type-mortality-dim text-type-mortality',
  water: 'bg-type-water-dim text-type-water',
  cull: 'bg-type-cull-dim text-type-cull',
  transfer: 'bg-type-transfer-dim text-type-transfer',
  harvest: 'bg-type-harvest-dim text-type-harvest',
};

export interface ListRowProps {
  /** Icon element (lucide, 18px) or a short mono code like "U-07". */
  leading?: ReactNode;
  tone?: RowTone;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned value — a time, a reading, a count. Set in mono by the caller. */
  trailing?: ReactNode;
  /** Renders as a button and shows a chevron. */
  onClick?: () => void;
  /** Completed / superseded rows fade rather than disappear. */
  muted?: boolean;
  className?: string;
}

export function ListRow({
  leading,
  tone = 'neutral',
  title,
  subtitle,
  trailing,
  onClick,
  muted = false,
  className,
}: ListRowProps): ReactElement {
  const content = (
    <>
      {leading !== undefined && (
        <span
          aria-hidden
          className={clsx(
            'w-10 h-10 shrink-0 rounded-xl inline-flex items-center justify-center',
            'text-meta font-semibold font-mono',
            TILE_CLASS[tone],
          )}
        >
          {leading}
        </span>
      )}
      <span className="flex-1 min-w-0 flex flex-col gap-1 text-left">
        <span className="text-title font-medium text-ink-1 truncate">{title}</span>
        {subtitle !== undefined && (
          <span className="text-body text-ink-3 truncate">{subtitle}</span>
        )}
      </span>
      {trailing !== undefined && (
        <span className="shrink-0 text-body font-semibold text-ink-2 whitespace-nowrap">
          {trailing}
        </span>
      )}
      {onClick && <ChevronRight size={15} className="shrink-0 text-ink-3" aria-hidden />}
    </>
  );

  const shared = twMerge(
    clsx(
      'w-full flex items-center gap-3 p-3 rounded-2xl border border-line bg-surface-1 shadow-token',
      muted && 'opacity-60',
    ),
    className,
  );

  if (!onClick) {
    return <div className={shared}>{content}</div>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={twMerge(
        shared,
        'min-h-touch touch-feedback focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc',
      )}
    >
      {content}
    </button>
  );
}
