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
