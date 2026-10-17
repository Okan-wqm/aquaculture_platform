/**
 * Active alarms — the five alarms of this workspace's module an operator
 * should look at first (model/alarms topAlarms), with their state and an
 * acknowledge action.
 *
 * WHAT: per row the priority glyph (the annunciator's), the alarm's message,
 * its rule and site, its state — UNACK while the condition stands, CLEARED once
 * it returned to normal unacknowledged, ACKED while it stands acknowledged —
 * and when it fired. An unacknowledged P1/P2 row is tinted with the hazard
 * colour (colour only for what needs someone). "All alarms" opens the alarm
 * list, which lives in the sensor module: the link appears only where the
 * viewer's tenant holds it, as the console's annunciator does.
 */
import {
  AnnunciatorGlyph,
  Button,
  useAuthContext,
  useI18n,
  type MessageKey,
} from '@aquaculture/shared-ui';
import type { AlertModule } from '@platform/shared-ui/generated/graphql-types';
import type { ReactElement } from 'react';

import { useAcknowledgeAlert, useModuleAlarms } from '../hooks/useModuleAlarms';
import type { AlarmRow, AlarmState } from '../model/alarms';
import { formatAge, formatClock } from '../model/format';

import { DashboardPanel } from './DashboardPanel';
import { PanelLink } from './PanelLink';

export const ALARM_LIST_PATH = '/sensor/alerts';

const STATE_KEY: Readonly<Record<AlarmState, MessageKey>> = {
  unack: 'dashboard.alarms.state.unack',
  cleared: 'dashboard.alarms.state.cleared',
  acked: 'dashboard.alarms.state.acked',
};

const STATE_CLASS: Readonly<Record<AlarmState, string>> = {
  unack: 'bg-sd-ink text-sd-paper',
  cleared: 'border-[1.5px] border-dashed border-sd-neutral-600 text-sd-neutral-800',
  acked: 'border border-sd-neutral-400 text-sd-neutral-800',
};

function rowClass(alarm: AlarmRow): string {
  if (alarm.state !== 'unack') return '';
  if (alarm.priority === 'p1') {
    return 'bg-sd-hz-red-tint shadow-[inset_5px_0_0_var(--color-sd-hz-red)]';
  }
  return alarm.priority === 'p2'
    ? 'bg-sd-hz-amber-tint shadow-[inset_5px_0_0_var(--color-sd-hz-amber)]'
    : 'shadow-[inset_5px_0_0_var(--color-sd-hz-amber)]';
}

export interface ActiveAlarmsPanelProps {
  readonly module: AlertModule;
  /** Names of the sites the viewer sees, to say where an alarm is. */
  readonly siteNames: ReadonlyMap<string, string>;
  readonly now: Date;
}

export function ActiveAlarmsPanel({
  module,
  siteNames,
  now,
}: ActiveAlarmsPanelProps): ReactElement {
  const { t, locale } = useI18n();
  const { hasModuleAccess } = useAuthContext();
  const alarms = useModuleAlarms(module);
  const acknowledge = useAcknowledgeAlert();
  const headingId = `dashboard-alarms-${module.toLowerCase()}`;

  return (
    <DashboardPanel
      headingId={headingId}
      title={t('dashboard.alarms.title')}
      action={
        hasModuleAccess('sensor') ? (
          <PanelLink to={ALARM_LIST_PATH} label={t('dashboard.alarms.all')} />
        ) : undefined
      }
    >
      {alarms.isError ? (
        <p role="alert" className="m-0 p-6 text-base text-sd-neutral-800">
          {t('dashboard.alarms.loadError')}
        </p>
      ) : alarms.data === undefined ? (
        <span aria-hidden="true" className="m-6 block h-12 animate-pulse bg-sd-neutral-200" />
      ) : alarms.data.length === 0 ? (
        <p className="m-0 p-6 text-base text-sd-neutral-800">{t('dashboard.alarms.empty')}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {alarms.data.map((alarm) => {
            const at = new Date(alarm.triggeredAt);
            const site =
              alarm.siteId === null
                ? t('dashboard.alarms.noSite')
                : (siteNames.get(alarm.siteId) ?? t('dashboard.alarms.noSite'));
            return (
              <li
                key={alarm.id}
                className={`flex items-center gap-4 border-b border-sd-rule px-6 py-3.5 ${rowClass(alarm)}`}
              >
                <AnnunciatorGlyph priority={alarm.priority} tone="hazard" size="inline" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span
                    className={`text-base leading-snug text-sd-ink ${alarm.state === 'unack' ? 'font-semibold' : 'font-medium'}`}
                  >
                    {alarm.message}
                  </span>
                  <span className="text-sm text-sd-neutral-700 tabular-nums">
                    {`${alarm.ruleName} · ${site}`}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1.5">
                  <span
                    className={`inline-flex min-h-6 items-center px-2 text-xs font-bold tracking-[0.06em] whitespace-nowrap ${STATE_CLASS[alarm.state]}`}
                  >
                    {t(STATE_KEY[alarm.state])}
                  </span>
                  <span className="text-sm whitespace-nowrap text-sd-neutral-700 tabular-nums">
                    {`${formatClock(at, locale)} · ${formatAge(at, now, locale)}`}
                  </span>
                </span>
                {alarm.state !== 'acked' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('dashboard.alarms.acknowledgeNamed', { name: alarm.ruleName })}
                    disabled={acknowledge.isPending}
                    onClick={() => acknowledge.mutate(alarm.id)}
                  >
                    {t('dashboard.alarms.acknowledge')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </DashboardPanel>
  );
}
