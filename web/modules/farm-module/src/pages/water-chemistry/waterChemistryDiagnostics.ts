export type WaterChemistryDiagnosticCode =
  | 'deffeyes-data-generation'
  | 'deffeyes-ph-data-generation'
  | 'report-print-fallback';

export interface WaterChemistryDiagnosticDetail {
  code: WaterChemistryDiagnosticCode;
  error: unknown;
}

export const WATER_CHEMISTRY_DIAGNOSTIC_EVENT = 'water-chemistry:diagnostic';

export function reportWaterChemistryDiagnostic(
  code: WaterChemistryDiagnosticCode,
  error: unknown
): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') {
    return;
  }

  window.dispatchEvent(new CustomEvent<WaterChemistryDiagnosticDetail>(
    WATER_CHEMISTRY_DIAGNOSTIC_EVENT,
    { detail: { code, error } }
  ));
}
