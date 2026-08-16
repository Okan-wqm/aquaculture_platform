/**
 * @aquaculture/backend-common/constants
 *
 * Shared regex + constant patterns consumed platform-wide.
 */

export { NATS_PATTERNS } from './nats-patterns';
export {
  DEVICE_CODE_REGEX,
  TENANT_ID_REGEX,
  UUID_REGEX,
  VALIDATION_PATTERNS,
} from './validation-patterns';
export {
  COMPLIANCE_WAIVER_MARKER_RE,
  PROTECTED_SCHEMAS,
  PROTECTED_TABLE_PATTERNS,
  PROTECTED_TABLES,
  isExplicitlyProtectedTable,
  isProtectedSchema,
  isProtectedTable,
  matchesProtectedTablePattern,
} from './protected-tables';
export type { ProtectedSchema, ProtectedTable } from './protected-tables';
