/**
 * The three non-data states every Today panel shares: a failed read says so
 * and offers a retry (never an empty list that reads as "nothing to see"), a
 * pending read shows the spinner, an empty read says what is empty.
 */
import React from 'react';
import { EmptyState, ErrorState, Spinner, useI18n } from '@aquaculture/shared-ui';

export interface PanelBodyProps {
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  isEmpty: boolean;
  emptyTitle: string;
  children: React.ReactNode;
}

export function PanelBody({
  isLoading,
  isError,
  onRetry,
  isEmpty,
  emptyTitle,
  children,
}: PanelBodyProps): React.JSX.Element {
  const { t } = useI18n();
  if (isError) {
    return (
      <ErrorState
        variant="plain"
        size="sm"
        title={t('hr.today.panelError')}
        retryLabel={t('common.retry')}
        onRetry={onRetry}
      />
    );
  }
  if (isLoading) return <Spinner size="md" block />;
  if (isEmpty) return <EmptyState variant="plain" size="sm" title={emptyTitle} />;
  return <>{children}</>;
}
