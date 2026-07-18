/**
 * VFD protocol configuration SSoT — classification, schema, defaults, validation.
 * Re-homed from the retired `vfd/adapters` module (SENSOR-CRITICAL-007/009).
 */
export {
  getVfdProtocolImplementationStatus,
  isSelectableVfdProtocol,
  getVfdProtocolSchema,
  getVfdProtocolDefaults,
  validateVfdProtocolConfig,
  getSelectableVfdProtocolInfo,
} from './vfd-protocol-catalog';
export type {
  ValidationResult,
  VfdProtocolInfo,
  VfdProtocolConnectionType,
} from './vfd-protocol-catalog';
