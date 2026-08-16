/**
 * PII (Personally Identifiable Information) Masking Utility
 *
 * Provides consistent masking of PII data across all backend services.
 * GDPR Article 5(1)(c) requires data minimization -- logs should contain
 * the minimum PII necessary for debugging. User IDs are always preferred
 * over email addresses in log output.
 *
 * @module pii-mask
 * @see https://gdpr.eu/article-5-how-to-process-personal-data/
 */

/**
 * Masks an email address for safe inclusion in log output.
 * Preserves the first character of the local part and domain for debugging
 * while hiding the rest to comply with GDPR data minimization requirements.
 *
 * @param email - The email address to mask
 * @returns A masked version of the email (e.g., 'j***@e***.com')
 *
 * @example
 * maskEmail('john.doe@example.com')  // => 'j***@e***.com'
 * maskEmail('a@b.co')                // => 'a***@b***.co'
 * maskEmail('')                      // => '***'
 * maskEmail('invalid')               // => '***'
 */
export function maskEmail(email: string): string {
  if (!email || !email.includes('@')) {
    return '***';
  }

  const [local, domain] = email.split('@');
  if (!local || !domain) {
    return '***';
  }

  const dotIndex = domain.lastIndexOf('.');
  if (dotIndex <= 0) {
    return `${local[0]}***@***`;
  }

  const domainName = domain.substring(0, dotIndex);
  const tld = domain.substring(dotIndex + 1);

  return `${local[0]}***@${domainName[0]}***.${tld}`;
}

/**
 * Returns a log-safe user identifier string.
 * Prefers user ID (sub or id) over email. If only email is available,
 * it is masked before being included in the output.
 *
 * SECURITY: This function ensures that no raw email addresses end up
 * in log files, preventing PII exposure through log aggregation systems,
 * error tracking tools, or cloud logging dashboards.
 *
 * @param user - An object containing user identification fields
 * @returns A log-safe identifier string (user ID or masked email)
 *
 * @example
 * logSafeUserId({ sub: 'abc-123' })                        // => 'abc-123'
 * logSafeUserId({ id: 'def-456' })                         // => 'def-456'
 * logSafeUserId({ email: 'john@example.com' })             // => 'j***@e***.com'
 * logSafeUserId({ sub: 'abc-123', email: 'john@ex.com' })  // => 'abc-123'
 * logSafeUserId({})                                         // => 'unknown'
 */
export function logSafeUserId(
  user: { sub?: string; id?: string; email?: string } | null | undefined,
): string {
  if (!user) {
    return 'unknown';
  }
  return user.sub || user.id || (user.email ? maskEmail(user.email) : 'unknown');
}

// ──────────────────────────────────────────────────────────────────────
// SECURITY (HIGH-005): value-pattern PII masking
// ──────────────────────────────────────────────────────────────────────
// The structured logger's key-based masker (SENSITIVE_KEYS regex) only
// catches leaves whose KEY name is suspicious. It does not help for
// arbitrary-keyed fields that hold PII (e.g. `logger.log({ details: "call from
// +15551234567 about foo@bar.com" })`). These helpers inspect the VALUE and
// redact patterns that look like PII regardless of where they appear.
// ──────────────────────────────────────────────────────────────────────

/** RFC5321-simplified email regex — correct enough for log scrubbing. */
const EMAIL_PATTERN =
  /([A-Za-z0-9_.+-])[A-Za-z0-9_.+-]*@([A-Za-z0-9])[A-Za-z0-9.-]*\.([A-Za-z]{2,})/g;

/** E.164 and common national formats: +CC followed by 7-15 digits, optional separators. */
const PHONE_PATTERN =
  /(?:\+\d{1,3}[\s-]?)?(?:\(\d{1,4}\)[\s-]?)?\d{3,4}[\s-]?\d{3,4}[\s-]?\d{3,4}/g;

/** 13–19 digit credit-card-like sequences (Luhn not validated — bias toward false-positive masking). */
const CREDIT_CARD_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;

/** US SSN format (other national ID schemes can be added here). */
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;

/** IPv4 private + public. Masks the last octet to retain debugging utility. */
const IPV4_PATTERN = /\b((?:\d{1,3}\.){3})\d{1,3}\b/g;

/**
 * Mask a phone number. Preserves country code and last two digits — enough
 * for correlation without revealing the full number.
 *
 * @example maskPhone('+15551234567') => '+1***67'
 */
export function maskPhone(phone: string): string {
  if (!phone) return '***';
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.length < 6) return '***';
  const prefix = digits.startsWith('+') ? digits.slice(0, Math.min(3, digits.length - 2)) : '';
  const tail = digits.slice(-2);
  return `${prefix}***${tail}`;
}

/**
 * Apply every value-pattern PII rule to an arbitrary string. Matches are
 * replaced with fixed tokens — not the per-value maskers — because the logger
 * path is hot and we optimise for speed of redaction, not for preserving
 * debuggability at the match site (the surrounding context in the log line
 * still provides the signal).
 *
 * Use `maskPii` for untyped log values, and `maskEmail`/`maskPhone` directly
 * for typed values where you want to keep some signal.
 */
export function maskPii(value: string): string {
  if (!value) return value;
  let result = value;
  // Order matters: credit card / SSN before phone because phone pattern
  // would otherwise swallow contiguous digit blocks.
  result = result.replace(CREDIT_CARD_PATTERN, '[CC-REDACTED]');
  result = result.replace(SSN_PATTERN, '[SSN-REDACTED]');
  result = result.replace(EMAIL_PATTERN, '[EMAIL-REDACTED]');
  result = result.replace(PHONE_PATTERN, '[PHONE-REDACTED]');
  result = result.replace(IPV4_PATTERN, '$1***');
  return result;
}

/**
 * Apply `maskPii` AND hard-truncate the result to a fixed maximum length.
 *
 * # Why truncation matters at the persistence boundary
 *
 * Stripe `last_payment_error.message`, refund-reason free-text input
 * fields, and similar third-party / user-supplied error strings are
 * theoretically unbounded. Persisting them to a Postgres `text`
 * column without a cap exposes the platform to:
 *
 *   - Storage exhaustion via deliberately-long error messages
 *     (a misbehaving upstream can fill a column with 10 MB strings).
 *   - Index-size blowup if the column is later promoted to a
 *     btree-indexed column.
 *   - Display-layer DoS in admin dashboards / invoice PDFs that
 *     embed the raw column without their own truncation.
 *
 * The `maskAndTruncatePii` helper applies both invariants in a
 * single pass — masking happens FIRST so the truncation marker
 * doesn't truncate mid-redaction-token (e.g.
 * `[CC-RED…<truncated>` would lose the redaction guarantee).
 *
 * # Why the marker text matters
 *
 * The trailing `…<truncated>` marker is the same shape used by
 * `AccessLogMiddleware.truncatePath` (AUDITTRAIL-HIGH-004 cure) so
 * forensic-search tooling can find every truncated value with one
 * regex regardless of stream.
 *
 * # Defaults
 *
 * `maxLen` defaults to 500, matching the column-cap recommendation
 * in BILLING-MEDIUM-003. Callers with stricter limits (e.g. log
 * lines with their own truncation) pass an explicit smaller cap.
 */
export function maskAndTruncatePii(value: string | null | undefined, maxLen = 500): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const masked = maskPii(value);
  if (masked.length <= maxLen) {
    return masked;
  }
  const marker = '…<truncated>';
  return `${masked.slice(0, maxLen - marker.length)}${marker}`;
}

/**
 * Recursively walk an object and apply `maskPii` to every string leaf.
 * Complements the structured logger's key-based masker — use the key masker
 * when the field NAME identifies the sensitivity, and this value masker
 * when the VALUE might contain PII regardless of the key.
 */
export function maskPiiDeep<T>(value: T, depth = 0, maxDepth = 4): T {
  if (depth > maxDepth || value == null) return value;
  if (typeof value === 'string') return maskPii(value) as unknown as T;
  if (Array.isArray(value)) {
    const items = value as readonly unknown[];
    return items.map((item) => maskPiiDeep(item, depth + 1, maxDepth)) as unknown as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskPiiDeep(v, depth + 1, maxDepth);
    }
    return out as unknown as T;
  }
  return value;
}
