/**
 * Canonical boot invariant signal contract.
 *
 * These strings are deploy contract surface, not free-form log copy. Emitters
 * must use the helpers in this file so the deploy asserter can validate a
 * structured signal (`message`, `bootSignal`, `status`) instead of matching
 * stale or incidental substrings.
 */

export const BOOT_INVARIANT_SIGNAL_AUTHORITY_PATH =
  'platform/libs/service-catalog/src/boot-invariant-signals.ts' as const;

export const BOOT_INVARIANT_SIGNALS = {
  schema_drift_clean: {
    pattern: 'Schema drift scan clean',
    description: 'SchemaDriftValidator found zero error-severity violations.',
  },
  nats_auth_mode_mtls: {
    pattern: 'NATS auth mode: mtls-cert',
    description: 'NATS client connected successfully with mTLS cert auth.',
  },
  db_migrate_complete: {
    pattern: 'aqua-db-migrate complete',
    description: 'Centralized db-migrate runner reached its success exit.',
  },
} as const;

export type BootInvariantSignalKey = keyof typeof BOOT_INVARIANT_SIGNALS;

export type BootInvariantSignalRecord<K extends BootInvariantSignalKey = BootInvariantSignalKey> = {
  readonly message: (typeof BOOT_INVARIANT_SIGNALS)[K]['pattern'];
  readonly bootSignal: K;
  readonly status: 'ok';
} & Record<string, unknown>;

export interface BootInvariantSignalLogger {
  log(message: string, ...optionalParams: unknown[]): void;
}

export function bootInvariantSignalRecord<K extends BootInvariantSignalKey>(
  key: K,
  metadata: Record<string, unknown> = {},
): BootInvariantSignalRecord<K> {
  return {
    ...metadata,
    message: BOOT_INVARIANT_SIGNALS[key].pattern,
    bootSignal: key,
    status: 'ok',
  };
}

export function emitBootInvariantSignal<K extends BootInvariantSignalKey>(
  logger: BootInvariantSignalLogger,
  key: K,
  metadata: Record<string, unknown> = {},
): BootInvariantSignalRecord<K> {
  const record = bootInvariantSignalRecord(key, metadata);
  const { message, ...structuredFields } = record;
  logger.log(message, structuredFields);
  return record;
}
