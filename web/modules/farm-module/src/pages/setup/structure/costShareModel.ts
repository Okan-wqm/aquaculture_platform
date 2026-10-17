/**
 * Cost share of a facility node — the shapes of the cost-share card's sample
 * figures (FARM-MEDIUM-440).
 *
 * WHY a model apart from the preview: what a site booked for electricity is
 * read from the finance ledger (useSiteElectricity), but no tariff is stored
 * and nothing splits a site's electricity below it, so those figures are
 * sample data in `costShare.preview.ts`. A stored tariff would return
 * SiteTariffSample's fact; a per-node power-meter rollup would return
 * ItemCostSample's two — the item's energy cost this month and its share of
 * its site's.
 */
import type { FacilityNodeKind } from './facilityTree';

export interface SiteTariffSample {
  /** ISO 4217 code of the tariff. */
  readonly currency: string;
  /** Electricity price per kWh, in `currency`. */
  readonly tariff: number;
}

export interface ItemCostSample {
  /** Energy cost of the item this month, in the sample's currency. */
  readonly cost: number;
  /** The item's share of its site's energy cost (0–1). */
  readonly siteShare: number;
}

export interface ItemCostShareSample {
  /** ISO 4217 code of every amount. */
  readonly currency: string;
  /** One sample per level below the site, so each level shows a plausible magnitude. */
  readonly below: Readonly<Record<Exclude<FacilityNodeKind, 'site'>, ItemCostSample>>;
}
