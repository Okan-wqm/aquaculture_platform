/**
 * The site cell: code · type (and the tank count where one is entered), the
 * site's name as the link into its page, and the freshness of its data.
 */
import { useI18n, type MessageKey } from '@aquaculture/shared-ui';
import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { Cell } from '../model/cell';
import { formatAge, formatClock } from '../model/format';
import type { DataFreshness } from '../model/production';

import { CellValue } from './CellValue';

const SITE_TYPE_KEYS: Readonly<Record<string, MessageKey>> = {
  HATCHERY: 'dashboard.siteType.HATCHERY',
  LAND_BASED: 'dashboard.siteType.LAND_BASED',
  POND: 'dashboard.siteType.POND',
  RACEWAY: 'dashboard.siteType.RACEWAY',
  RECIRCULATING: 'dashboard.siteType.RECIRCULATING',
  SEA_CAGE: 'dashboard.siteType.SEA_CAGE',
};

export interface SiteIdentityProps {
  readonly code: string;
  readonly type: string;
  readonly name: string;
  readonly href: string;
  /** Beside the type: the tank count, already worded, with its source. */
  readonly extra?: ReactNode;
  readonly data?: Cell<DataFreshness>;
  readonly now: Date;
}

export function SiteIdentity({
  code,
  type,
  name,
  href,
  extra,
  data,
  now,
}: SiteIdentityProps): ReactElement {
  const { t, locale } = useI18n();
  const typeKey = SITE_TYPE_KEYS[type];
  return (
    <div className="flex min-h-11 flex-col justify-center gap-0.5">
      <span className="font-display-sd text-sm font-semibold tracking-[0.08em] whitespace-nowrap text-sd-neutral-700">
        {code}
        {typeKey !== undefined && ` · ${t(typeKey)}`}
        {extra}
      </span>
      <Link
        to={href}
        className="text-base leading-tight font-semibold text-sd-ink hover:text-sd-accent-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {name}
      </Link>
      {data !== undefined && (
        <span className="text-sm whitespace-nowrap tabular-nums">
          <CellValue cell={data}>
            {(freshness) =>
              freshness.state === 'none' ? (
                <span className="text-sd-neutral-700">{t('dashboard.sites.data.none')}</span>
              ) : freshness.state === 'stale' ? (
                <span className="font-semibold text-sd-neutral-800">
                  {t('dashboard.sites.data.stale', { age: formatAge(freshness.at, now, locale) })}
                </span>
              ) : (
                <span className="text-sd-neutral-700">
                  {t('dashboard.sites.data.good', { time: formatClock(freshness.at, locale) })}
                </span>
              )
            }
          </CellValue>
        </span>
      )}
    </div>
  );
}
