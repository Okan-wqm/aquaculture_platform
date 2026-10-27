/**
 * The site + module scope of an alarm read (ALERT-MEDIUM-010).
 *
 * WHY one function: the alarm list (getAlertHistory) and the active counts
 * (countActiveAlerts) narrow by the same scope, and a count must hold exactly
 * the rows the list it opens shows. Writing the two clauses once keeps them
 * from drifting apart.
 *
 * WHAT: equality on site and on module; an absent part does not narrow.
 */
import type { SelectQueryBuilder } from 'typeorm';

import type { AlertHistory } from '../entities/alert-history.entity';
import type { OwnerModuleCode } from '@aquaculture/shared-contracts';

export interface AlertHistoryScope {
  readonly siteId?: string;
  readonly module?: OwnerModuleCode;
}

export function applyAlertHistoryScope(
  query: SelectQueryBuilder<AlertHistory>,
  scope: AlertHistoryScope | undefined,
): void {
  if (scope?.siteId !== undefined) {
    query.andWhere('alert.siteId = :siteId', { siteId: scope.siteId });
  }
  if (scope?.module !== undefined) {
    query.andWhere('alert.module = :module', { module: scope.module });
  }
}
