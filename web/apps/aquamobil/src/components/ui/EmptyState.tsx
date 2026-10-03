/**
 * EmptyState / ErrorState — "there is nothing here" and "we could not load it",
 * said properly and never alike.
 *
 * WHY components: before v4 each list hand-rolled its own empty case, several
 * rendered nothing at all — a blank area under a heading, which reads as a
 * failed load rather than an empty list — and a failed query fell into the
 * empty branch, so the worker read "No tanks found" when the request had
 * failed. On a boat with intermittent signal that difference matters: "no
 * alarms" is good news, "we could not fetch alarms" is not.
 *
 * `tone="error"` keeps the two visually distinct; ErrorState is the error tone
 * with its retry wired, so a failure always says so and always offers one.
 */
import { useI18n } from '@aquaculture/shared-ui/i18n';
import { clsx } from 'clsx';
import { AlertTriangle } from 'lucide-react';
import { type ReactElement, type ReactNode } from 'react';

import { Button } from './Button';

export interface EmptyStateProps {
  /** Lucide icon element, 22px. */
  icon?: ReactNode;
  /** The headline, e.g. "No alarms" — state the fact, not an apology. */
  title: string;
  /** One line of context or next step. */
  description?: ReactNode;
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

export interface ErrorStateProps {
  /** Names the failure; defaults to the generic "Could not load". */
  title?: string;
  description?: ReactNode;
  /** Shows a retry button. */
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}

export function ErrorState({
  title,
  description,
  onRetry,
  retrying = false,
  className,
}: ErrorStateProps): ReactElement {
  const { t } = useI18n();
  return (
    <EmptyState
      tone="error"
      icon={<AlertTriangle size={22} />}
      title={title ?? t('m.common.couldNotLoad')}
      description={description}
      className={className}
      action={
        onRetry && (
          <Button variant="primary" onClick={onRetry} loading={retrying}>
            {t('m.common.retry')}
          </Button>
        )
      }
    />
  );
}
