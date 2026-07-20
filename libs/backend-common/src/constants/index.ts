/**
 * @aquaculture/backend-common/constants
 *
 * Shared regex + constant patterns consumed platform-wide.
 */

export { NATS_PATTERNS } from './nats-patterns';
export { SYSTEM_ACTOR_ID } from './system-actor';
export {
  BOOT_INVARIANT_SIGNALS,
  bootInvariantSignalRecord,
  emitBootInvariantSignal,
} from './boot-invariant-signals';
export type {
  BootInvariantSignalKey,
  BootInvariantSignalLogger,
  BootInvariantSignalRecord,
} from './boot-invariant-signals';
export {
  DEVICE_CODE_REGEX,
  TENANT_ID_REGEX,
  UUID_REGEX,
  VALIDATION_PATTERNS,
} from './validation-patterns';
export {
  APPEND_ONLY_TABLES,
  COMPLIANCE_WAIVER_MARKER_RE,
  LIFECYCLE_GUARDED_TABLES,
  PROTECTED_SCHEMAS,
  PROTECTED_TABLE_PATTERNS,
  PROTECTED_TABLES,
  appendOnlyTableBaseNames,
  isExplicitlyProtectedTable,
  isProtectedSchema,
  isProtectedTable,
  matchesProtectedTablePattern,
} from './protected-tables';
export type {
  AppendOnlyTable,
  LifecycleGuardedTable,
  ProtectedSchema,
  ProtectedTable,
} from './protected-tables';
