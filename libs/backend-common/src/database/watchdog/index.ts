// Watchdog scanners
export { SourceSchemaScanner } from './source-schema-scanner';
export { CrossTenantProbe } from './cross-tenant-probe';
export { SchemaDriftDetector } from './schema-drift-detector';

// Watchdog runner (orchestrator)
export { WatchdogRunner } from './watchdog-runner';

// Types
export type {
  WatchdogViolation,
  ViolationSeverity,
  ViolationType,
} from './source-schema-scanner';

export type {
  WatchdogScanOptions,
  WatchdogScanSummary,
  WatchdogReport,
} from './watchdog-runner';
