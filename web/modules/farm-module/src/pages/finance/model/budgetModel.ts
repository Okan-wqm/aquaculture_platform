/**
 * Budget vs actual per cost centre — the shape of the Budget tab's figures and
 * the arithmetic the tab draws from them (FARM-MEDIUM-439).
 *
 * WHY a model apart from the preview: farm-service has no budget entity yet,
 * so the figures are sample data in `preview/budget.preview.ts`. When the
 * budget query lands it returns this shape and the same arithmetic runs on
 * real rows; only the source changes.
 *
 * WHAT: the month-end forecast projects the month-to-date spend at its daily
 * rate (actual / day × days in month), and a centre is flagged by that
 * forecast against its budget (severity.ts).
 */
import type { LocalizedText } from './localizedText';
import { severityOf, type Severity } from './severity';

export interface BudgetCentreSample {
  /** Short cost-centre code, e.g. `AQ`. */
  readonly code: string;
  readonly name: LocalizedText;
  /** The role answerable for the centre's spend. */
  readonly owner: LocalizedText;
  /** Monthly budget, in thousands of the sample's currency. */
  readonly budget: number;
  /** Month-to-date spend, in thousands of the sample's currency. */
  readonly actual: number;
}

export interface BudgetSample {
  /** ISO 4217 code of every amount. */
  readonly currency: string;
  /** The budget month; `month` is 1–12. */
  readonly month: { readonly year: number; readonly month: number };
  /** The last day the actuals cover. */
  readonly dayOfMonth: number;
  readonly centres: readonly BudgetCentreSample[];
}

export interface BudgetRow extends BudgetCentreSample {
  /** actual / budget. */
  readonly used: number;
  /** Month-end spend at the month-to-date daily rate. */
  readonly forecast: number;
  /** forecast / budget. */
  readonly forecastRatio: number;
  /** forecast − budget: positive is an overrun. */
  readonly variance: number;
  readonly severity: Severity;
}

export interface BudgetView {
  readonly rows: readonly BudgetRow[];
  /** dayOfMonth / daysInMonth: where today sits on every row's bar. */
  readonly pace: number;
  readonly daysInMonth: number;
}

/** Days in `month` (1–12) of `year`: day 0 of the next month is this month's last day. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function budgetView(sample: BudgetSample): BudgetView {
  const days = daysInMonth(sample.month.year, sample.month.month);
  const rows = sample.centres.map((centre): BudgetRow => {
    const forecast = (centre.actual / sample.dayOfMonth) * days;
    const forecastRatio = forecast / centre.budget;
    return {
      ...centre,
      used: centre.actual / centre.budget,
      forecast,
      forecastRatio,
      variance: forecast - centre.budget,
      severity: severityOf(forecastRatio),
    };
  });
  return { rows, pace: sample.dayOfMonth / days, daysInMonth: days };
}
