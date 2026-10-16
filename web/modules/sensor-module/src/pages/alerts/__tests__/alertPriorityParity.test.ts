/**
 * A tile and the list it opens hold the same alarms (README §7.5).
 *
 * The shell counts a tile as the alarms shared-ui's isOnTile admits
 * (web/shell console/data/alarmPriority.spec.ts pins its counts to the same
 * predicate). Here the other side: every alarm state — each severity,
 * acknowledged or not, open or cleared — is run through the variables the
 * list sends for a tile's filter, read the way alert-engine's alertHistory
 * reads them (one clause per variable, pinned by alert-rule.history-filter
 * and alert.resolver specs), and the rows the list would hold must be exactly
 * the rows the tile counts. Equal sets give equal totals per tile, whatever
 * mix of alarms the tenant has.
 */
import { describe, expect, it } from 'vitest';

import { ANNUNCIATOR_FILTERS, isOnTile, type AnnunciatorAlarm } from '@aquaculture/shared-ui';
import type { AlertSeverity } from '@platform/shared-ui/generated/graphql-types';

import { alertHistoryVariables, type AlertHistoryVariables } from '../../../hooks/useAlerts';
import { filterForPriority } from '../alertPriorityFilter';

const ALL_SEVERITIES: readonly AlertSeverity[] = [
  'CRITICAL',
  'HIGH',
  'MEDIUM',
  'WARNING',
  'LOW',
  'INFO',
];

const EVERY_ALARM: readonly AnnunciatorAlarm[] = ALL_SEVERITIES.flatMap((severity) =>
  [false, true].flatMap((acknowledged) =>
    [false, true].map((resolved) => ({ severity, acknowledged, resolved })),
  ),
);

/** alert-engine's alertHistory WHERE: `severity IN`, `acknowledged =`, `resolved =`, each only when sent. */
function serverAdmits(variables: AlertHistoryVariables, alarm: AnnunciatorAlarm): boolean {
  return (
    (variables.severities === undefined || variables.severities.includes(alarm.severity)) &&
    (variables.acknowledged === undefined || variables.acknowledged === alarm.acknowledged) &&
    (variables.resolved === undefined || variables.resolved === alarm.resolved)
  );
}

describe('annunciator tile ↔ alarm list parity', () => {
  it.each(ANNUNCIATOR_FILTERS)(
    'the list a %s tile opens holds exactly the alarms it counts',
    (tile) => {
      const variables = alertHistoryVariables({ ...filterForPriority(tile), page: 1, limit: 20 });

      const listed = EVERY_ALARM.filter((alarm) => serverAdmits(variables, alarm));
      const counted = EVERY_ALARM.filter((alarm) => isOnTile(tile, alarm));

      expect(listed).toEqual(counted);
      expect(counted.length).toBeGreaterThan(0);
    },
  );

  it('leaves no cleared alarm and no advisory in a tile list', () => {
    for (const tile of ANNUNCIATOR_FILTERS) {
      const variables = alertHistoryVariables({ ...filterForPriority(tile), page: 1, limit: 20 });
      const listed = EVERY_ALARM.filter((alarm) => serverAdmits(variables, alarm));
      expect(listed.filter((alarm) => alarm.resolved)).toEqual([]);
      expect(
        listed.filter((alarm) => alarm.severity === 'LOW' || alarm.severity === 'INFO'),
      ).toEqual([]);
    }
  });
});
