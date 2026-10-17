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
 * default every other reader (the alarm list, AquaMobil) pages by. Either way
 * the alarm's id breaks the last tie, so rows that share a severity and a
 * trigger time keep one order and a page boundary neither repeats nor drops
 * one of them.
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
 * Below every ranked severity. A value the database enum carries but this
 * code does not (a migration adding a severity lands before every pod that
 * serves the list runs the code that ranks it) would make the CASE yield
 * NULL, and Postgres sorts NULL first under DESC — above every CRITICAL. It
 * ranks last instead, where an alarm nobody can classify cannot push a known
 * CRITICAL off a short page.
 */
const UNRANKED_SEVERITY = -1;

/**
 * The SQL rank of `alias`.severity — ALERT_SEVERITY_RANK spelled as a CASE,
 * since the column's enum values sort alphabetically, not by severity; a
 * severity it does not name ranks UNRANKED_SEVERITY. Built from the enum's
 * own constants, never from input.
 */
export function severityRankSql(alias: string): string {
  const arms = Object.entries(ALERT_SEVERITY_RANK)
    .map(([severity, rank]) => `WHEN '${severity}' THEN ${rank}`)
    .join(' ');
  return `CASE ${alias}.severity ${arms} ELSE ${UNRANKED_SEVERITY} END`;
}
