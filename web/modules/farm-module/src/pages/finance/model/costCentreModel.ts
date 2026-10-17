/**
 * Cost centres and unit production cost — the shape of the Cost centres tab's
 * figures and the arithmetic the tab draws from them (FARM-MEDIUM-440).
 *
 * WHY a model apart from the preview: no cost centre exists in farm-service
 * yet (an expense carries a category, a site and a batch only), so the
 * register and the unit costs are sample data in
 * `preview/costCentres.preview.ts`. When cost centres bound to the location
 * tree land, their query returns this shape and the same arithmetic runs.
 *
 * WHAT: unit cost is the period's cost over the period's output (cost in
 * thousands per output in thousands of its unit, so ₺ per kg for tonnes and
 * ₺ per 1,000 fry for millions of fry), flagged against its target.
 */
import type { LocalizedText } from './localizedText';
import { severityOf, type Severity } from './severity';

export interface CostCentreSample {
  readonly code: string;
  readonly name: LocalizedText;
  /** The sites whose expenses the centre collects. */
  readonly sites: readonly LocalizedText[];
  readonly owner: LocalizedText;
}

export interface UnitCostSample {
  readonly site: LocalizedText;
  /** Code of the register's centre this site's production cost is booked to. */
  readonly centreCode: string;
  /** Output in the period (biomass gain or harvest), in thousands of the unit `outputUnit` names. */
  readonly output: number;
  readonly outputUnit: LocalizedText;
  /** Cost in the period, in thousands of the sample's currency. */
  readonly cost: number;
  /** Target unit cost, in `unit`. */
  readonly target: number;
  /** The unit of unit cost, e.g. ₺/kg. */
  readonly unit: LocalizedText;
  /** Feed's share of the cost (0–1), or null where feed is not a cost line. */
  readonly feedShare: number | null;
}

export interface CostCentresSample {
  /** ISO 4217 code of every amount. */
  readonly currency: string;
  /** The reporting period; `month` is 1–12. */
  readonly period: {
    readonly year: number;
    readonly month: number;
    readonly fromDay: number;
    readonly toDay: number;
  };
  readonly centres: readonly CostCentreSample[];
  /** How the register's centres collect expenses — part of the sample, as the model it shows. */
  readonly registerNote: LocalizedText;
  readonly unitCosts: readonly UnitCostSample[];
  /** What the unit costs count and leave out — part of the sample, as the model it shows. */
  readonly unitNote: LocalizedText;
}

export interface UnitCostRow extends UnitCostSample {
  readonly centreName: LocalizedText;
  readonly unitCost: number;
  readonly severity: Severity;
}

export function unitCostRows(sample: CostCentresSample): UnitCostRow[] {
  const centres = new Map(sample.centres.map((centre) => [centre.code, centre]));
  return sample.unitCosts.map((row): UnitCostRow => {
    const centre = centres.get(row.centreCode);
    // A unit cost booked to a centre the register does not hold is a broken
    // sample, not a row to render with a blank centre.
    if (centre === undefined) {
      throw new Error(`unitCostRows: cost centre ${row.centreCode} is not in the register`);
    }
    const unitCost = row.cost / row.output;
    return {
      ...row,
      centreName: centre.name,
      unitCost,
      severity: severityOf(unitCost / row.target),
    };
  });
}
