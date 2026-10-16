/**
 * Sample figures of the facility node's cost-share card, for what has no
 * record yet (FARM-MEDIUM-440): the tariff of a site — none is stored — and
 * the energy cost of an item below a site, since electricity is booked per
 * site only and no power-meter rollup splits it further. Rendered only
 * through MockPreview, which draws the notice naming the finding beside them.
 * A site's own electricity this month is real: useSiteElectricity reads it
 * from the finance ledger.
 *
 * The figures follow the Tenant Console D6 design's Ayvalık example
 * (tenant-assets.js: cost = kW × 24 h × 14.45 d × ₺3.20/kWh): its grow-out
 * department at 38.5 kW (89 % of the site), a grow-out line at 11.3 kW (26 %)
 * and its circulation pump at 4.7 kW (11 %). Every node of a level shows the
 * same sample — the notice says it is not the node's own.
 */
import { definePreviewData } from '@aquaculture/shared-ui';

import type { ItemCostShareSample, SiteTariffSample } from './costShareModel';

const TARIFF: SiteTariffSample = { currency: 'TRY', tariff: 3.2 };

const BELOW_SITE: ItemCostShareSample = {
  currency: 'TRY',
  below: {
    department: { cost: 42726, siteShare: 0.893 },
    system: { cost: 12540, siteShare: 0.262 },
    equipment: { cost: 5216, siteShare: 0.109 },
  },
};

export const SITE_TARIFF_PREVIEW = definePreviewData(
  {
    finding: 'FARM-MEDIUM-440',
    reasonKey: 'facilityStructure.cost.tariffPreviewReason',
    needs: 'farm-service electricity tariff per site (price per kWh), stored with the site',
  },
  TARIFF,
);

export const ITEM_COST_SHARE_PREVIEW = definePreviewData(
  {
    finding: 'FARM-MEDIUM-440',
    reasonKey: 'facilityStructure.cost.previewReason',
    needs:
      'farm-service per-node energy cost rollup (power-meter channels bound to department, system and equipment) splitting the site electricity ledger',
  },
  BELOW_SITE,
);
