/**
 * SEC-L05: Shared JWT security constants to prevent divergence between services.
 *
 * NIST SP 800-117 recommends HMAC keys be at least as long as the hash output
 * (256 bits = 32 bytes for HS256). We centralize this constant so that auth-service,
 * gateway-api, admin-api-service, and any future consumer share a single source of truth.
 */
export const JWT_SECURITY_CONSTANTS = {
  /** Minimum length for JWT secret in characters */
  JWT_SECRET_MIN_LENGTH: 32,
} as const;

/**
 * SEC-L15: Centralized sensitive field definitions for consistent PII redaction.
 *
 * All audit logging, error handling, and data export must use this list
 * to determine which fields to redact. Local per-service definitions are
 * replaced by this single source of truth to prevent redaction gaps where
 * one service redacts 'password' but another misses 'apiKey', etc.
 *
 * Categories:
 * - Authentication: password, token, secret, apiKey, refreshToken, accessToken
 * - PII: email, firstName, lastName, phone, ssn, dateOfBirth, address
 * - Financial: creditCard, bankAccount, iban, routingNumber
 * - Internal: encryptionKey, privateKey, certificate, connectionString
 * - Domain-specific: mqttPasswordHash, provisioningToken, appKey, etc.
 */
export const SENSITIVE_FIELDS: readonly string[] = [
  // Authentication credentials
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'apiKey',
  'apiSecret',
  'clientSecret',
  'mfaSecret',

  // PII (Personally Identifiable Information)
  'email',
  'firstName',
  'lastName',
  'phone',
  'phoneNumber',
  'mobile',
  'ssn',
  'socialSecurityNumber',
  'dateOfBirth',
  'dob',
  'address',
  'nationalId',
  'passportNumber',
  'driverLicense',

  // Financial data
  'creditCard',
  'cardNumber',
  'cvv',
  'bankAccount',
  'iban',
  'routingNumber',
  'accountNumber',

  // Internal infrastructure secrets
  'encryptionKey',
  'privateKey',
  'certificate',
  'connectionString',
  'databaseUrl',
  'redisUrl',
  'natsUrl',

  // Domain-specific (IoT / sensor infrastructure)
  'appKey',
  'clientPrivateKey',
  'clientCertificate',
  'serverCertificate',
  'provisioningToken',
  'mqttPasswordHash',
] as const;

/** Type-safe union of all sensitive field names for compile-time checks. */
export type SensitiveFieldName = (typeof SENSITIVE_FIELDS)[number];

/**
 * Set-based lookup for O(1) sensitive field checks.
 * Use this when checking individual keys in a loop for better performance
 * than Array.includes() on the readonly array.
 */
export const SENSITIVE_FIELDS_SET: ReadonlySet<string> = new Set(SENSITIVE_FIELDS);

/**
 * Check whether a field key matches any sensitive field name (case-insensitive substring match).
 *
 * This is the recommended approach for sanitizing request bodies where field names
 * may be nested or use slightly different casing (e.g., 'userPassword', 'ApiKey').
 * For exact-match redaction (e.g., audit log columns), use SENSITIVE_FIELDS_SET.has() instead.
 */
export function isSensitiveField(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return SENSITIVE_FIELDS.some((f) => lowerKey.includes(f.toLowerCase()));
}
