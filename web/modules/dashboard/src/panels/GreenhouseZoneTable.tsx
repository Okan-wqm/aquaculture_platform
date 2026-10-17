/**
 * The Greenhouse dashboard's Site status table — as a labelled preview.
 *
 * WHY: hydroponics-service keeps no greenhouse zones, nutrient readings or
 * dosing state (FARM-MEDIUM-443), so the table renders the design's sample
 * zones only through MockPreview, beside the notice naming the finding and
 * what is missing. The columns are the real table's: EC max against its
 * target, pH, air temperature against its target, dosing; a zone opens the
 * nutrient solution's water analysis.
 */
import { MockPreview, useI18n } from '@aquaculture/shared-ui';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { formatDecimal } from '../model/format';
import type { GreenhouseZoneRow } from '../model/greenhouse';
import { GREENHOUSE_ZONES_PREVIEW } from '../preview/greenhouseZones.preview';

import { SiteStatusTable, type SiteColumn } from './SiteStatusTable';

export const WATER_ANALYSIS_PATH = '/hydroponics/solution/water_analysis';

const VALUE_CLASS = 'font-display-sd text-lg leading-tight font-semibold tabular-nums';
const NOTE_CLASS = 'text-sm text-sd-neutral-700';

function outside(value: number, [min, max]: readonly [number, number]): boolean {
  return value < min || value > max;
}

export function GreenhouseZoneTable(): ReactElement {
  const { t, locale } = useI18n();
  const range = (target: readonly [number, number], digits: number): Record<string, string> => ({
    min: formatDecimal(target[0], digits, locale),
    max: formatDecimal(target[1], digits, locale),
  });

  const columns: SiteColumn<GreenhouseZoneRow>[] = [
    {
      key: 'zone',
      header: t('dashboard.greenhouse.column.zone'),
      render: (zone) => (
        <div className="flex min-h-11 flex-col justify-center gap-0.5">
          <span className="font-display-sd text-sm font-semibold tracking-[0.08em] text-sd-neutral-700">
            {zone.code}
          </span>
          <Link
            to={WATER_ANALYSIS_PATH}
            className="text-base leading-tight font-semibold text-sd-ink hover:text-sd-accent-700 hover:underline"
          >
            {zone.name}
          </Link>
        </div>
      ),
    },
    {
      key: 'ec',
      header: t('dashboard.greenhouse.column.ec'),
      render: (zone) => (
        <>
          <div
            className={`${VALUE_CLASS} ${outside(zone.ecMax, zone.ecTarget) ? 'text-sd-hz-amber-ink' : 'text-sd-ink'}`}
          >
            {t('dashboard.greenhouse.ec', { value: formatDecimal(zone.ecMax, 1, locale) })}
          </div>
          <div className={NOTE_CLASS}>
            {t('dashboard.greenhouse.ecTarget', range(zone.ecTarget, 1))}
          </div>
        </>
      ),
    },
    {
      key: 'ph',
      header: t('dashboard.greenhouse.column.ph'),
      render: (zone) => (
        <span className={`${VALUE_CLASS} text-sd-ink`}>{formatDecimal(zone.ph, 1, locale)}</span>
      ),
    },
    {
      key: 'air',
      header: t('dashboard.greenhouse.column.air'),
      render: (zone) => (
        <>
          <div
            className={`${VALUE_CLASS} ${outside(zone.airC, zone.airTarget) ? 'text-sd-hz-amber-ink' : 'text-sd-ink'}`}
          >
            {t('dashboard.greenhouse.air', { value: formatDecimal(zone.airC, 1, locale) })}
          </div>
          <div className={NOTE_CLASS}>
            {t('dashboard.greenhouse.airTarget', range(zone.airTarget, 0))}
          </div>
        </>
      ),
    },
    {
      key: 'dosing',
      header: t('dashboard.greenhouse.column.dosing'),
      render: (zone) => (
        <span className="text-sm font-semibold text-sd-ink">
          {t(
            zone.dosing === 'running'
              ? 'dashboard.greenhouse.dosing.running'
              : 'dashboard.greenhouse.dosing.paused',
          )}
        </span>
      ),
    },
  ];

  return (
    <MockPreview data={GREENHOUSE_ZONES_PREVIEW} variant="block">
      {(zones) => (
        <SiteStatusTable
          headingId="dashboard-sites-greenhouse"
          title={t('dashboard.sites.title')}
          footnote={t('dashboard.greenhouse.footnote')}
          columns={columns}
          rows={zones}
          rowKey={(zone) => zone.id}
          loading={false}
          failed={false}
        />
      )}
    </MockPreview>
  );
}
