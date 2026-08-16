/**
 * ReDoS-Safe Regex Patterns
 *
 * This module provides safe regex patterns that are resistant to
 * Regular Expression Denial of Service (ReDoS) attacks.
 *
 * ReDoS occurs when a regex with nested quantifiers or overlapping
 * alternations is given a crafted input that causes exponential backtracking.
 *
 * Guidelines for safe regex:
 * 1. Avoid nested quantifiers (e.g., (a+)+)
 * 2. Avoid overlapping alternations (e.g., (a|a)+)
 * 3. Use atomic groups or possessive quantifiers when possible
 * 4. Set reasonable length limits before regex matching
 * 5. Use timeouts for complex patterns
 */

/**
 * Email validation - ReDoS safe
 * Based on a simplified pattern that covers most valid emails
 */
export const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/**
 * UUID v4 validation - ReDoS safe.
 *
 * WHY `UUID_V4_REGEX` (not `UUID_REGEX`): the constants barrel exports
 * `UUID_REGEX` that accepts UUID v1-v5 (`[1-5]`), while this pattern is
 * strictly v4 (`4`). Previously the root backend-common barrel exposed
 * both under the same name and the explicit re-export from constants
 * shadowed this one by accident. The semantic distinction (v4-only vs
 * any-version) is load-bearing — a v1 UUID would pass the constants
 * check but fail this one — so making the names reflect it prevents the
 * caller from picking the wrong one silently. See AUDIT-MEDIUM-005.
 */
export const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * UUID any version - ReDoS safe. Kept for API parity with the v1-v5
 * `UUID_REGEX` in `constants/validation-patterns.ts`; the two differ
 * only in case-sensitivity/version range and both are loose enough for
 * cross-boundary ID checks.
 */
export const UUID_ANY_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Phone number - International format, ReDoS safe
 * Allows: +1234567890, +1-234-567-8900, +1 234 567 8900
 */
export const PHONE_REGEX = /^\+?[1-9]\d{0,2}[\s.-]?\(?\d{1,4}\)?.[\s.-]?\d{1,4}[\s.-]?\d{1,9}$/;

/**
 * Username - Alphanumeric with underscores, ReDoS safe
 */
export const USERNAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]{2,29}$/;

/**
 * Slug - URL-safe identifier, ReDoS safe
 */
export const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * IPv4 address - ReDoS safe
 */
export const IPV4_REGEX =
  /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?.[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?.[0-9])$/;

/**
 * IPv6 address - ReDoS safe (simplified)
 */
export const IPV6_REGEX = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::1$|^::$/;

/**
 * Hexadecimal string - ReDoS safe
 */
export const HEX_REGEX = /^[0-9a-fA-F]+$/;

/**
 * Base64 string - ReDoS safe
 */
export const BASE64_REGEX = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Alphanumeric - ReDoS safe
 */
export const ALPHANUMERIC_REGEX = /^[a-zA-Z0-9]+$/;

/**
 * Alpha only - ReDoS safe
 */
export const ALPHA_REGEX = /^[a-zA-Z]+$/;

/**
 * Numeric only - ReDoS safe
 */
export const NUMERIC_REGEX = /^[0-9]+$/;

/**
 * Password strength - ReDoS safe
 * Requires: 8+ chars, 1 uppercase, 1 lowercase, 1 number, 1 special
 * Note: Check each requirement separately for safety
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_HAS_UPPERCASE = /[A-Z]/;
export const PASSWORD_HAS_LOWERCASE = /[a-z]/;
export const PASSWORD_HAS_NUMBER = /[0-9]/;
export const PASSWORD_HAS_SPECIAL = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/;

/**
 * Check password strength safely
 */
export function isStrongPassword(password: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) {
    errors.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (password.length > 128) {
    errors.push('Password must be at most 128 characters');
  }
  if (!PASSWORD_HAS_UPPERCASE.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  if (!PASSWORD_HAS_LOWERCASE.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  if (!PASSWORD_HAS_NUMBER.test(password)) {
    errors.push('Password must contain at least one number');
  }
  if (!PASSWORD_HAS_SPECIAL.test(password)) {
    errors.push('Password must contain at least one special character');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Date format - ISO 8601, ReDoS safe
 */
export const ISO_DATE_REGEX = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/**
 * DateTime format - ISO 8601, ReDoS safe
 */
export const ISO_DATETIME_REGEX =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/;

/**
 * URL - Simplified, ReDoS safe
 */
export const URL_REGEX =
  /^https?:\/\/[a-zA-Z0-9][-a-zA-Z0-9]*(?:\.[a-zA-Z0-9][-a-zA-Z0-9]*)+(?::\d{1,5})?(?:\/[^\s]*)?$/;

/**
 * Domain name - ReDoS safe
 */
export const DOMAIN_REGEX = /^[a-zA-Z0-9][-a-zA-Z0-9]*(?:\.[a-zA-Z0-9][-a-zA-Z0-9]*)+$/;

/**
 * Semantic version - ReDoS safe
 */
export const SEMVER_REGEX =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*)?(?:\+[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*)?$/;

/**
 * Credit card number (basic) - ReDoS safe
 * For actual validation, use a proper library
 */
export const CREDIT_CARD_REGEX = /^\d{13,19}$/;

/**
 * SQL identifier - Safe for table/column names
 */
export const SQL_IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

/**
 * JSON path - Simple validation, ReDoS safe
 */
export const JSON_PATH_REGEX =
  /^(?:\$|\$\.[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*|\[\d+\])*)$/;

/**
 * Safe regex test with timeout protection
 * @param pattern - Regex pattern
 * @param input - Input string to test
 * @param maxLength - Maximum input length to test (default 10000)
 * @returns Match result or null if input too long
 */
export function safeRegexTest(pattern: RegExp, input: string, maxLength = 10000): boolean | null {
  if (input.length > maxLength) {
    return null; // Input too long
  }
  return pattern.test(input);
}

/**
 * Safe regex match with length limit
 */
export function safeRegexMatch(
  pattern: RegExp,
  input: string,
  maxLength = 10000,
): RegExpMatchArray | null {
  if (input.length > maxLength) {
    return null;
  }
  return input.match(pattern);
}
