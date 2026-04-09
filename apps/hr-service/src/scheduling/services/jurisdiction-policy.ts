/**
 * JurisdictionPolicy — configurable overtime threshold per jurisdiction.
 *
 * HR-HIGH-009: The 45-hour weekly threshold was hardcoded. Multi-country
 * tenants get wrong overtime calculations. This interface + registry makes
 * the threshold configurable per jurisdiction, with the 45h Turkish default
 * as fallback.
 *
 * Each tenant can configure their jurisdiction via SchedulingSettings.
 * The system looks up the policy from the registry; unknown jurisdictions
 * fall back to the Turkish default.
 *
 * WHY an interface, not just a number: jurisdictions differ in more than
 * just the weekly threshold. Some have daily caps, mandatory rest periods,
 * and different overtime multiplier tiers. The interface is extensible.
 */
export interface JurisdictionPolicy {
  /** ISO 3166-1 alpha-2 country code */
  readonly jurisdictionCode: string;

  /** Human-readable jurisdiction name */
  readonly name: string;

  /** Standard weekly working minutes (before overtime kicks in) */
  readonly standardWeeklyMinutes: number;

  /** Maximum allowed overtime minutes per week */
  readonly maxOvertimeMinutesPerWeek: number;

  /** Maximum allowed overtime minutes per month */
  readonly maxOvertimeMinutesPerMonth: number;

  /** Maximum daily working minutes (0 = no daily cap) */
  readonly maxDailyMinutes: number;

  /** Minimum rest minutes between shifts */
  readonly minRestBetweenShifts: number;
}

/**
 * Pre-defined jurisdiction policies for common labor law regimes.
 *
 * These are the legal defaults. Tenants can override via SchedulingSettings,
 * but these serve as the platform defaults for each jurisdiction.
 */
export const JURISDICTION_POLICIES: ReadonlyMap<string, JurisdictionPolicy> = new Map([
  [
    'TR',
    {
      jurisdictionCode: 'TR',
      name: 'Turkey (Turkish Labor Law 4857)',
      standardWeeklyMinutes: 2700, // 45 hours
      maxOvertimeMinutesPerWeek: 720, // 12 hours
      maxOvertimeMinutesPerMonth: 2880, // 48 hours
      maxDailyMinutes: 660, // 11 hours
      minRestBetweenShifts: 660, // 11 hours
    },
  ],
  [
    'EU',
    {
      jurisdictionCode: 'EU',
      name: 'EU Working Time Directive (2003/88/EC)',
      standardWeeklyMinutes: 2880, // 48 hours
      maxOvertimeMinutesPerWeek: 0, // 48h is the absolute cap
      maxOvertimeMinutesPerMonth: 0,
      maxDailyMinutes: 780, // 13 hours (24 - 11 rest)
      minRestBetweenShifts: 660, // 11 hours
    },
  ],
  [
    'US',
    {
      jurisdictionCode: 'US',
      name: 'US Fair Labor Standards Act (FLSA)',
      standardWeeklyMinutes: 2400, // 40 hours
      maxOvertimeMinutesPerWeek: 1200, // 20 hours (no legal max, but practical)
      maxOvertimeMinutesPerMonth: 4800, // 80 hours
      maxDailyMinutes: 0, // No federal daily cap
      minRestBetweenShifts: 480, // 8 hours (industry standard)
    },
  ],
  [
    'NO',
    {
      jurisdictionCode: 'NO',
      name: 'Norway (Working Environment Act)',
      standardWeeklyMinutes: 2250, // 37.5 hours
      maxOvertimeMinutesPerWeek: 600, // 10 hours
      maxOvertimeMinutesPerMonth: 1500, // 25 hours
      maxDailyMinutes: 540, // 9 hours
      minRestBetweenShifts: 660, // 11 hours
    },
  ],
]);

/**
 * Default jurisdiction for tenants without explicit configuration.
 * Turkish labor law (the platform's origin jurisdiction).
 */
export const DEFAULT_JURISDICTION_CODE = 'TR';

/**
 * Look up the jurisdiction policy for a given code.
 * Falls back to Turkish default if the code is not found.
 *
 * @param jurisdictionCode - ISO country code or custom jurisdiction identifier
 * @returns JurisdictionPolicy for the given jurisdiction
 */
export function getJurisdictionPolicy(jurisdictionCode?: string): JurisdictionPolicy {
  if (!jurisdictionCode) {
    return JURISDICTION_POLICIES.get(DEFAULT_JURISDICTION_CODE)!;
  }
  return (
    JURISDICTION_POLICIES.get(jurisdictionCode.toUpperCase()) ??
    JURISDICTION_POLICIES.get(DEFAULT_JURISDICTION_CODE)!
  );
}
