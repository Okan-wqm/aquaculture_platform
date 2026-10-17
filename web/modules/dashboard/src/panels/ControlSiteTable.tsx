/**
 * The Control & sensors dashboard's Site status table: per site the sensor
 * module's open alarms, the gateways online and their newest report, the
 * registered sensors and the PLC connections with their active PLC alarms
 * (model/control). A site row opens the device list.
 */
import { useI18n } from '@aquaculture/shared-ui';
import type { ReactElement } from 'react';

import { useControlRows } from '../hooks/useControlRows';
import { worstPriority } from '../model/alarms';
import type { ControlSiteRow } from '../model/control';
import { formatAge, formatClock } from '../model/format';

import { AlarmTally } from './AlarmTally';
import { CellValue } from './CellValue';
import { SiteIdentity } from './SiteIdentity';
import { SiteStatusTable, type SiteColumn } from './SiteStatusTable';

const VALUE_CLASS = 'font-display-sd text-lg leading-tight font-semibold tabular-nums text-sd-ink';
const NOTE_CLASS = 'text-sm text-sd-neutral-700';

export const DEVICE_LIST_PATH = '/sensor/devices';

export function ControlSiteTable({ now }: { readonly now: Date }): ReactElement {
  const { t, locale } = useI18n();
  const { sites, rows } = useControlRows();

  const columns: SiteColumn<ControlSiteRow>[] = [
    {
      key: 'site',
      header: t('dashboard.sites.column.site'),
      render: (row) => (
        <SiteIdentity
          code={row.code}
          type={row.type}
          name={row.name}
          href={DEVICE_LIST_PATH}
          now={now}
        />
      ),
    },
    {
      key: 'alarms',
      header: t('dashboard.sites.column.alarms'),
      width: '120px',
      render: (row) => (
        <CellValue cell={row.alarms}>{(tally) => <AlarmTally tally={tally} />}</CellValue>
      ),
    },
    {
      key: 'gateways',
      header: t('dashboard.control.column.gateways'),
      render: (row) => (
        <CellValue cell={row.gateways}>
          {(gateways) =>
            gateways.total === 0 ? (
              <span className={NOTE_CLASS}>{t('dashboard.control.gatewaysNone')}</span>
            ) : (
              <>
                <div
                  className={`${VALUE_CLASS} ${gateways.online < gateways.total ? 'text-sd-hz-amber-ink' : ''}`}
                >
                  {t('dashboard.control.gateways', {
                    online: gateways.online,
                    total: gateways.total,
                  })}
                </div>
                {gateways.lastSeenAt !== null && (
                  <div className={NOTE_CLASS} title={formatClock(gateways.lastSeenAt, locale)}>
                    {t('dashboard.control.lastSeen', {
                      age: formatAge(gateways.lastSeenAt, now, locale),
                    })}
                  </div>
                )}
              </>
            )
          }
        </CellValue>
      ),
    },
    {
      key: 'sensors',
      header: t('dashboard.control.column.sensors'),
      render: (row) => (
        <CellValue cell={row.sensors}>
          {(count) => (
            <span className={VALUE_CLASS}>
              {t(
                count === 1 ? 'dashboard.control.sensors.one' : 'dashboard.control.sensors.other',
                {
                  count,
                },
              )}
            </span>
          )}
        </CellValue>
      ),
    },
    {
      key: 'plc',
      header: t('dashboard.control.column.plc'),
      render: (row) => (
        <CellValue cell={row.plcs}>
          {(plcs) =>
            plcs.total === 0 ? (
              <span className={NOTE_CLASS}>{t('dashboard.control.plcNone')}</span>
            ) : (
              <>
                <div
                  className={`${VALUE_CLASS} ${plcs.online < plcs.total ? 'text-sd-hz-amber-ink' : ''}`}
                >
                  {t('dashboard.control.plc', { online: plcs.online, total: plcs.total })}
                </div>
                {plcs.activeAlarms > 0 && (
                  <div className="text-sm font-semibold text-sd-hz-amber-ink">
                    {t(
                      plcs.activeAlarms === 1
                        ? 'dashboard.control.plcAlarms.one'
                        : 'dashboard.control.plcAlarms.other',
                      { count: plcs.activeAlarms },
                    )}
                  </div>
                )}
              </>
            )
          }
        </CellValue>
      ),
    },
  ];

  return (
    <SiteStatusTable
      headingId="dashboard-sites-control"
      title={t('dashboard.sites.title')}
      status={
        sites.dataUpdatedAt > 0
          ? t('dashboard.sites.updated', {
              time: formatClock(new Date(sites.dataUpdatedAt), locale),
            })
          : undefined
      }
      footnote={t('dashboard.control.footnote')}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.siteId}
      alarmOf={(row) => (row.alarms.status === 'ready' ? worstPriority(row.alarms.value) : null)}
      loading={sites.isLoading}
      failed={sites.isError}
    />
  );
}
