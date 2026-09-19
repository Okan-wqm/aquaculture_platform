/**
 * EmptyState / ErrorState — what a list shows when it has nothing, and when it
 * could not load.
 *
 * WHY: every page centred its own icon + two lines for "nothing here", and a
 * failed query fell into that same branch — the worker read "No tanks found"
 * when the request had failed. One block for each, so an error always says
 * so and always offers a retry.
 */
import { AlertCircle, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from './Button';

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className = '' }: EmptyStateProps): ReactNode {
  return (
    <div className={`text-center py-12 text-gray-400 dark:text-gray-500 ${className}`}>
      {Icon && <Icon size={48} className="mx-auto mb-3 opacity-30" aria-hidden />}
      <p className="font-medium">{title}</p>
      {description && <p className="text-sm mt-1">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  description?: ReactNode;
  /** Shows a Retry button. */
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}

export function ErrorState({
  title = 'Could not load',
  description,
  onRetry,
  retrying = false,
  className = '',
}: ErrorStateProps): ReactNode {
  return (
    <div role="alert" className={`text-center py-12 text-gray-500 dark:text-gray-400 ${className}`}>
      <AlertCircle size={48} className="mx-auto mb-3 text-red-500" aria-hidden />
      <p className="font-medium text-gray-900 dark:text-white">{title}</p>
      {description && <p className="text-sm mt-1">{description}</p>}
      {onRetry && (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" onClick={onRetry} loading={retrying}>
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
