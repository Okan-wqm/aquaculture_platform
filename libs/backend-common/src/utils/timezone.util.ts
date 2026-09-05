/**
 * IANA timezone validation — one validator, every writer (W5).
 *
 * Tenant localization (`auth.tenants.settings.localization.timezone`) is the
 * platform-wide clock SSoT: the farm feeding engine schedules a tenant's day
 * plans, sweeps and daily summary in that zone. An unvalidated string reaching
 * that column is not a cosmetic problem — `Intl.DateTimeFormat` throws
 * `RangeError` on an unknown zone, so a typo would abort every scheduled
 * feeding job for that tenant.
 *
 * Every boundary that accepts a zone (the auth GraphQL mutation, the
 * farm-side projection consumer) runs this check and rejects loudly; nobody
 * silently substitutes UTC for an unparseable value.
 */

/**
 * True when the string is an IANA zone identifier the runtime can resolve.
 *
 * Note this deliberately rejects legacy abbreviations such as `EST` or `CET`
 * on runtimes that do not map them: those are ambiguous about DST and would
 * silently shift a tenant's feeding day twice a year.
 */
export function isValidIanaTimeZone(timezone: unknown): timezone is string {
  if (typeof timezone !== 'string' || timezone.trim().length === 0) return false;
  try {
    // Constructing the formatter is the resolution test — an unknown zone
    // throws RangeError here, which is exactly the failure we must catch at
    // the boundary rather than inside a cron.
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the string is a canonicalisable BCP-47 language tag (`tr`,
 * `en-GB`). Locale never feeds scheduling, but a malformed tag would break
 * downstream `Intl` formatting the same way.
 */
export function isValidBcp47Locale(locale: unknown): locale is string {
  if (typeof locale !== 'string' || locale.trim().length === 0) return false;
  try {
    return Intl.getCanonicalLocales(locale).length === 1;
  } catch {
    return false;
  }
}
