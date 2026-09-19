/**
 * EmptyState / ErrorState — what a surface shows when it has nothing, or
 * could not load (FE-HIGH-085).
 *
 * WHY: 133 empty states in farm-module alone were written by hand (a centred
 * block, a pasted SVG, a title, a subtitle, sometimes a button), and four
 * different error presentations coexisted on the dashboard for the same kind
 * of failure. One shape — icon, title, description, action — means a list
 * with no rows, a failed query and a search with no hits all read the same,
 * carry both palettes, and can be retuned centrally.
 */
import React from 'react';

import { useI18n } from '../../i18n';

import { Button } from '../Button';
import { CircleAlert, Inbox } from 'lucide-react';

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

export interface EmptyStateProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** A lucide icon or any node; sized by the component */
  icon?: React.ReactNode;
  /** Primary call to action ("Add feed") */
  action?: EmptyStateAction;
  /** Secondary link-like action ("Clear filters") */
  secondaryAction?: EmptyStateAction;
  /** `card` (default) draws a bordered surface; `plain` sits inside one */
  variant?: 'card' | 'plain';
  size?: 'sm' | 'md';
  className?: string;
}

const DefaultIcon: React.FC = () => <Inbox className="h-12 w-12" aria-hidden="true" />;

export const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  description,
  icon,
  action,
  secondaryAction,
  variant = 'card',
  size = 'md',
  className = '',
}) => (
  <div
    className={`flex flex-col items-center text-center ${size === 'sm' ? 'gap-2 py-8' : 'gap-3 py-12'} ${
      variant === 'card'
        ? 'rounded-lg border border-gray-200 bg-white px-6 dark:border-gray-700 dark:bg-gray-900'
        : ''
    } ${className}`}
  >
    <div className="text-gray-400 dark:text-gray-500 [&>svg]:h-12 [&>svg]:w-12">
      {icon ?? <DefaultIcon />}
    </div>
    <h3
      className={`font-medium text-gray-900 dark:text-gray-100 ${size === 'sm' ? 'text-sm' : 'text-base'}`}
    >
      {title}
    </h3>
    {description && (
      <p className="max-w-md text-sm text-gray-500 dark:text-gray-400">{description}</p>
    )}
    {(action || secondaryAction) && (
      <div className="mt-2 flex items-center gap-3">
        {action && (
          <Button variant="primary" size="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        )}
        {secondaryAction && (
          <Button variant="ghost" size="sm" onClick={secondaryAction.onClick}>
            {secondaryAction.label}
          </Button>
        )}
      </div>
    )}
  </div>
);

export interface ErrorStateProps {
  title?: React.ReactNode;
  /** The failure in words a user can act on; never a stack trace */
  description?: React.ReactNode;
  /** "Retry" — re-runs the query */
  onRetry?: () => void;
  retryLabel?: string;
  variant?: 'card' | 'plain';
  size?: 'sm' | 'md';
  className?: string;
}

const ErrorIcon: React.FC = () => <CircleAlert className="h-12 w-12" aria-hidden="true" />;

/** A surface that could not load. Announced as an alert; offers one retry. */
export const ErrorState: React.FC<ErrorStateProps> = ({
  title: titleProp,
  description,
  onRetry,
  retryLabel: retryLabelProp,
  variant = 'card',
  size = 'md',
  className = '',
}) => {
  const { t } = useI18n();
  const title = titleProp ?? t('common.somethingWentWrong');
  const retryLabel = retryLabelProp ?? t('common.retry');
  return (
    <div
      role="alert"
      className={`flex flex-col items-center text-center ${size === 'sm' ? 'gap-2 py-8' : 'gap-3 py-12'} ${
        variant === 'card'
          ? 'rounded-lg border border-error-200 bg-error-50 px-6 dark:border-error-800 dark:bg-error-900/20'
          : ''
      } ${className}`}
    >
      <div className="text-error-500 dark:text-error-400">
        <ErrorIcon />
      </div>
      <h3
        className={`font-medium text-error-800 dark:text-error-200 ${size === 'sm' ? 'text-sm' : 'text-base'}`}
      >
        {title}
      </h3>
      {description && (
        <p className="max-w-md text-sm text-error-700 dark:text-error-300">{description}</p>
      )}
      {onRetry && (
        <div className="mt-2">
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      )}
    </div>
  );
};
