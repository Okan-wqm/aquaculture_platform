/**
 * The electricity a site booked this month — the cost-share card's real
 * figure, read from the finance ledger (useSiteElectricity) and drawn apart
 * from the card's preview so it never reads as sample data, nor sample data
 * as it.
 *
 * Nothing booked reads as such, never as ₺0; a failed read says so; and a
 * month whose lines run past what one read can total points to the expenses
 * list instead of showing a partial sum.
 */
import { Spinner, useI18n } from '@aquaculture/shared-ui';
import React from 'react';

import { formatMoney } from '../../finance/model/financeFormat';

import { KICKER, MUTED_TEXT, TILE, TILE_FIGURE, TILE_GRID } from './panelStyles';
import { useSiteElectricity } from './useSiteElectricity';

export function SiteElectricityTile({ siteId }: { siteId: string }): React.ReactElement {
  const { t, locale } = useI18n();
  const electricity = useSiteElectricity(siteId);

  return (
    <dl className={TILE_GRID}>
      <div className={TILE}>
        <dt className={KICKER}>{t('facilityStructure.cost.electricity')}</dt>
        {electricity.status === 'loading' ? (
          <dd>
            <Spinner size="sm" label={t('common.loading')} />
          </dd>
        ) : null}
        {electricity.status === 'error' ? (
          <dd>
            <p role="alert" className="text-sm text-error-700 dark:text-error-300">
              {t('facilityStructure.cost.electricityError')}
            </p>
          </dd>
        ) : null}
        {electricity.status === 'too-many' ? (
          <dd className={MUTED_TEXT}>{t('facilityStructure.cost.electricityTooMany')}</dd>
        ) : null}
        {electricity.status === 'ready' && electricity.totals.length === 0 ? (
          <dd className={MUTED_TEXT}>{t('facilityStructure.cost.electricityNone')}</dd>
        ) : null}
        {/* One figure per currency booked: amounts of different currencies are never added. */}
        {electricity.status === 'ready'
          ? electricity.totals.map((total) => (
              <dd key={total.currency} className={TILE_FIGURE}>
                {formatMoney(total.amount, total.currency, locale)}
              </dd>
            ))
          : null}
      </div>
    </dl>
  );
}
