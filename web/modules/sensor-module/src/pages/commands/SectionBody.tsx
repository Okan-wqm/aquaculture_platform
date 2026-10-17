/**
 * The three non-data states every recorded section shares: a failed read says
 * so and offers a retry (never an empty table that reads as "nothing was
 * sent"), a pending read shows the spinner, an empty read says what is empty.
 */
import React from 'react';
import { EmptyState, ErrorState, Spinner, useI18n } from '@aquaculture/shared-ui';

export interface SectionBodyProps {
  isLoading: boolean;
  isError: boolean;
  errorTitle: string;
  onRetry: () => void;
  isEmpty: boolean;
  emptyTitle: string;
  children: React.ReactNode;
}

export function SectionBody({
  isLoading,
  isError,
  errorTitle,
  onRetry,
  isEmpty,
  emptyTitle,
  children,
}: SectionBodyProps): React.JSX.Element {
  const { t } = useI18n();
  if (isError) {
    return (
      <ErrorState
        variant="plain"
        size="sm"
        title={errorTitle}
        retryLabel={t('common.retry')}
        onRetry={onRetry}
      />
    );
  }
  if (isLoading) return <Spinner size="md" block label={t('common.loading')} />;
  if (isEmpty) return <EmptyState variant="plain" size="sm" title={emptyTitle} />;
  return <>{children}</>;
}
