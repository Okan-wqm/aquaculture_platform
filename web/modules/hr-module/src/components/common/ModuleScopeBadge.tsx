/**
 * ModuleScopeBadge — says whose people a scoped HR screen is showing.
 *
 * The scope is not in the URL: it is the workspace the reader is in (see
 * useModuleScope), so the same /hr/employees shows Production people in one
 * workspace and everyone in Company. Every scoped page puts this badge in its
 * header so "where did my staff go" always has a visible answer. One component,
 * not one copy per page.
 */
import React from 'react';
import { useI18n } from '@aquaculture/shared-ui';
import { useModuleScope } from '../../hooks/useModuleScope';
import { scopeLabel } from '../../utils/moduleLabels';
import { StatusBadge } from './StatusBadge';

interface ModuleScopeBadgeProps {
  className?: string;
}

export function ModuleScopeBadge({ className }: ModuleScopeBadgeProps): React.ReactElement {
  const { t } = useI18n();
  const label = scopeLabel(useModuleScope(), t);

  // The look is StatusBadge's (the one badge the module draws); the wrapper only carries the hover hint.
  return (
    <span title={t('hr.module.showing', { label })} className={className}>
      <StatusBadge label={label} variant="primary" size="sm" />
    </span>
  );
}

export default ModuleScopeBadge;
