/**
 * Cost share of the selected facility node — the design's cost tile (Tenant
 * Console D6 `assets`).
 *
 * WHY three sources: on a site, the electricity it booked this month is real
 * (SiteElectricityTile reads the finance ledger), while its tariff is not
 * stored; below a site, electricity is not split by item. Those two have no
 * record (FARM-MEDIUM-440), so they are sample data, reachable only through
 * MockPreview, whose notice names the finding and says what is missing. Only
 * the node's level picks which sample shows; nothing of the node itself is
 * mixed into the sample figures.
 *
 * Finance reads are open to tenant admins and module managers only
 * (useCanReadFinance), so other roles see that instead of any cost figure —
 * the preview models nothing those roles could ever see.
 */
import { MockPreview, useI18n, type MessageKey } from '@aquaculture/shared-ui';
import React, { useId } from 'react';

import { formatMoney, formatRatio } from '../../finance/model/financeFormat';
import { useCanReadFinance } from '../../finance/useCanReadFinance';

import { ITEM_COST_SHARE_PREVIEW, SITE_TARIFF_PREVIEW } from './costShare.preview';
import type { ItemCostShareSample, SiteTariffSample } from './costShareModel';
import type { FacilityNode, FacilityNodeKind } from './facilityTree';
import {
  CARD_HEADING,
  FRAME,
  KICKER,
  MUTED_TEXT,
  TILE,
  TILE_FIGURE,
  TILE_GRID,
} from './panelStyles';
import { SiteElectricityTile } from './SiteElectricityTile';

interface Tile {
  labelKey: MessageKey;
  value: string;
}

function Tiles({ tiles }: { tiles: readonly Tile[] }): React.ReactElement {
  const { t } = useI18n();
  return (
    <dl className={TILE_GRID}>
      {tiles.map((tile) => (
        <div key={tile.labelKey} className={TILE}>
          <dt className={KICKER}>{t(tile.labelKey)}</dt>
          <dd className={TILE_FIGURE}>{tile.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function TariffFigures({ sample }: { sample: SiteTariffSample }): React.ReactElement {
  const { t, locale } = useI18n();
  return (
    <Tiles
      tiles={[
        {
          labelKey: 'facilityStructure.cost.tariff',
          value: t('facilityStructure.cost.perKwh', {
            price: formatMoney(sample.tariff, sample.currency, locale, 2),
          }),
        },
      ]}
    />
  );
}

function ItemCostFigures({
  sample,
  kind,
}: {
  sample: ItemCostShareSample;
  kind: Exclude<FacilityNodeKind, 'site'>;
}): React.ReactElement {
  const { locale } = useI18n();
  const item = sample.below[kind];
  return (
    <Tiles
      tiles={[
        {
          labelKey: 'facilityStructure.cost.month',
          value: formatMoney(item.cost, sample.currency, locale),
        },
        {
          labelKey: 'facilityStructure.cost.siteShare',
          value: formatRatio(item.siteShare, locale),
        },
      ]}
    />
  );
}

function CostShareBody({ node }: { node: FacilityNode }): React.ReactElement {
  if (node.kind === 'site') {
    return (
      <>
        <SiteElectricityTile siteId={node.siteId} />
        <MockPreview data={SITE_TARIFF_PREVIEW} variant="block">
          {(sample) => <TariffFigures sample={sample} />}
        </MockPreview>
      </>
    );
  }
  return (
    <MockPreview data={ITEM_COST_SHARE_PREVIEW} variant="block">
      {(sample) => <ItemCostFigures sample={sample} kind={node.kind} />}
    </MockPreview>
  );
}

export function CostShareCard({ node }: { node: FacilityNode }): React.ReactElement {
  const { t } = useI18n();
  const headingId = useId();
  const canReadFinance = useCanReadFinance();
  return (
    <section aria-labelledby={headingId} className={`flex flex-col gap-3 px-5 py-4 ${FRAME}`}>
      <h3 id={headingId} className={CARD_HEADING}>
        {t('facilityStructure.cost.title')}
      </h3>
      {canReadFinance ? (
        <CostShareBody node={node} />
      ) : (
        <p className={MUTED_TEXT}>{t('facilityStructure.cost.restricted')}</p>
      )}
    </section>
  );
}
