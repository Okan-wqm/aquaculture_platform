/**
 * @aquaculture/backend-common/constants
 *
 * Shared regex + constant patterns consumed platform-wide.
 */

export { NATS_PATTERNS } from './nats-patterns';
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
  LIFECYCLE_MUTATED_TABLES,
  PROTECTED_TABLE_POLICIES,
  PROTECTED_SCHEMAS,
  PROTECTED_TABLE_PATTERNS,
  PROTECTED_TABLES,
  ROW_DELETE_POLICY,
  ROW_MUTATION_POLICY,
  appendOnlyTableBaseNames,
  isExplicitlyProtectedTable,
  isProtectedSchema,
  isProtectedTable,
  matchesProtectedTablePattern,
  protectedTableName,
  rowGuardTablePoliciesForSchema,
} from './protected-tables';
export type {
  AppendOnlyTable,
  LifecycleMutatedTable,
  ProtectedSchema,
  ProtectedTable,
  ProtectedTablePolicy,
  RowDeletePolicy,
  RowMutationPolicy,
} from './protected-tables';
