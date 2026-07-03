/**
 * Report-period conversions — the SSoT for translating the form's month
 * representation to the backend/Mattilsynet contract.
 *
 * WHY (FARM-HIGH-127): the report forms carry a 0-indexed month (JavaScript
 * Date convention), but the backend reportMonth / Mattilsynet rapporteringsmaaned
 * is 1–12. Biomass added +1 inline; Smolt and Cleaner-Fish sent the raw 0-indexed
 * value, filing every settefisk/rensefisk report a month early (and an invalid
 * month 0 for January). One helper removes the chance for a tab to get it wrong.
 */

/** Convert a 0-indexed form month (0=January) to the 1–12 backend reportMonth. */
export function toBackendReportMonth(formMonthZeroIndexed: number): number {
  return formMonthZeroIndexed + 1;
}

/** Convert a 1–12 backend reportMonth back to the 0-indexed form month. */
export function fromBackendReportMonth(backendMonthOneIndexed: number): number {
  return backendMonthOneIndexed - 1;
}
