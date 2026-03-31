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
