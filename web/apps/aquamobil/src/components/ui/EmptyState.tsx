/**
 * EmptyState — "there is nothing here" said properly.
 *
 * WHY it is a component: before v4 each list hand-rolled its own empty case, and
 * several rendered nothing at all — a blank area under a heading, which reads as
 * a failed load rather than an empty list. On a boat with intermittent signal
 * that difference matters: "no alarms" is good news, "we could not fetch alarms"
 * is not, and they must never look the same.
 *
 * `tone="error"` exists for the second case, so the two states stay visually
 * distinct rather than sharing one grey shrug.
 */
import { clsx } from 'clsx';
import { type ReactElement, type ReactNode } from 'react';

export interface EmptyStateProps {
  /** Lucide icon element, 22px. */
  icon?: ReactNode;
  /** The headline, e.g. "No alarms" — state the fact, not an apology. */
  title: string;
  /** One line of context or next step. */
  description?: string;
  /** A recovery or primary action — a <Button/>. */
  action?: ReactNode;
  /** `empty` = nothing to show (normal); `error` = we could not load. */
  tone?: 'empty' | 'error';
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = 'empty',
  className,
}: EmptyStateProps): ReactElement {
  return (
    <div
      className={clsx('flex flex-col items-center text-center gap-3 px-6 py-10', className)}
      // An error state is announced; an ordinary empty list is not, because a
      // screen reader interrupting to say "no alarms" on every refresh is noise.
      role={tone === 'error' ? 'alert' : undefined}
    >
      {icon !== undefined && (
        <span
          aria-hidden
          className={clsx(
            'w-12 h-12 rounded-2xl inline-flex items-center justify-center',
            tone === 'error' ? 'bg-crit-dim text-crit' : 'bg-surface-2 text-ink-3',
          )}
        >
          {icon}
        </span>
      )}
      <span className="text-title font-semibold text-ink-1">{title}</span>
      {description !== undefined && (
        <span className="text-body text-ink-3 max-w-xs">{description}</span>
      )}
      {action}
    </div>
  );
}
