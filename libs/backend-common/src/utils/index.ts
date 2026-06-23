/**
 * @aquaculture/backend-common/utils
 *
 * PII masking, service identity, HMAC tenant hash, PG error sanitization.
 * Every helper here is intended for cross-service reuse; anything service-
 * specific belongs under the owning service, not in this barrel.
 */

export * from './service-identity.util';
export * from './lifecycle-timer';
export {
  maskEmail,
  logSafeUserId,
  maskPhone,
  maskPii,
  maskPiiDeep,
  maskAndTruncatePii,
} from './pii-mask.util';
export {
  TENANT_HASH_PEPPER_ENV,
  hmacTenantHash,
  tenantHashesEqual,
  assertTenantHashPepperSet,
} from './hmac-tenant-hash.util';
export {
  sanitizePgError,
  assertNoPgRowLeak,
  PG_ERROR_ROW_LEAK_PATTERN,
} from './sanitize-pg-error.util';
export type { SanitizedPgError } from './sanitize-pg-error.util';
