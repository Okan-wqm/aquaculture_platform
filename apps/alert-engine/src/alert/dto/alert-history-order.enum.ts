import { registerEnumType } from '@nestjs/graphql';

import { ALERT_SEVERITY_RANK } from '../../database/entities/alert-rule.entity';

/**
 * The order alertHistory pages its rows in.
 *
 * WHY: a page of the newest alarms can leave out an older CRITICAL behind
 * newer, milder ones — a module dashboard's Active alarms panel asks for 50
 * rows and must never drop the alarm an operator should see first. Asked
 * MOST_SEVERE_FIRST, the page holds the most severe alarms (the newest first
 * within a severity), so the limit cuts the mildest. NEWEST_FIRST stays the
 * default every other reader (the alarm list, AquaMobil) pages by.
 */
export enum AlertHistoryOrder {
  NEWEST_FIRST = 'newest_first',
  MOST_SEVERE_FIRST = 'most_severe_first',
}

registerEnumType(AlertHistoryOrder, {
  name: 'AlertHistoryOrder',
  description:
    'NEWEST_FIRST (default): by trigger time. MOST_SEVERE_FIRST: by severity, the newest first within one',
});

/**
 * The SQL rank of `alias`.severity — ALERT_SEVERITY_RANK spelled as a CASE,
 * since the column's enum values sort alphabetically, not by severity. Built
 * from the enum's own constants, never from input.
 */
export function severityRankSql(alias: string): string {
  const arms = Object.entries(ALERT_SEVERITY_RANK)
    .map(([severity, rank]) => `WHEN '${severity}' THEN ${rank}`)
    .join(' ');
  return `CASE ${alias}.severity ${arms} END`;
}
