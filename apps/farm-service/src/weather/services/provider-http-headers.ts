const IMF_FIXDATE_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;

/**
 * Parses the two Retry-After forms emitted by current HTTP senders:
 * decimal delta-seconds and IMF-fixdate. Numeric alternatives such as
 * exponent notation are not valid delta-seconds and are rejected.
 */
export function parseProviderRetryAfterMs(
  value: string | null,
  now: Date,
  maximumMs: number,
): number | undefined {
  if (Number.isNaN(now.getTime()) || !Number.isSafeInteger(maximumMs) || maximumMs < 0) {
    throw new RangeError('Retry-After parser requires a valid clock and millisecond limit');
  }
  if (value === null || value.length === 0) return undefined;

  if (/^\d+$/u.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds) || seconds >= Math.ceil(maximumMs / 1_000)) {
      return maximumMs;
    }
    return Math.min(maximumMs, seconds * 1_000);
  }

  if (!IMF_FIXDATE_PATTERN.test(value)) return undefined;
  const retryAtMs = Date.parse(value);
  if (!Number.isFinite(retryAtMs)) return undefined;
  return Math.min(maximumMs, Math.max(0, retryAtMs - now.getTime()));
}
