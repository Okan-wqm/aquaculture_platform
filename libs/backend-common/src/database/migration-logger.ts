/**
 * MigrationLogger
 *
 * Structured logging utility for TypeORM migrations.
 *
 * TypeORM migrations run outside the NestJS DI container — they cannot
 * inject Logger via constructor. The standard pattern of `console.log()`
 * bypasses the platform's structured JSON logging pipeline (Winston/Pino),
 * making migration progress invisible to log aggregators (Loki, OpenSearch).
 *
 * Enterprise pattern: instantiate NestJS Logger directly (it works without DI).
 * All migrations MUST use this instead of console.log/warn/error.
 *
 * Usage:
 *   import { MigrationLogger } from '@aquaculture/backend-common/database';
 *
 *   export class MyMigration1234 implements MigrationInterface {
 *     private readonly logger = new MigrationLogger('MyMigration1234');
 *
 *     async up(queryRunner: QueryRunner): Promise<void> {
 *       this.logger.log('Starting migration...');
 *       this.logger.warn('Potentially slow — large table');
 *     }
 *   }
 *
 * @module Database
 */
import { Logger } from '@nestjs/common';

function formatLogValue(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean' ||
    typeof value === 'undefined'
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? '[unserializable]';
  } catch {
    return '[unserializable]';
  }
}

export class MigrationLogger {
  private readonly logger: Logger;

  constructor(migrationName: string) {
    // Prefix ensures log lines are instantly identifiable as migration output
    // in aggregated logs alongside service logs from the same binary.
    this.logger = new Logger(`Migration:${migrationName}`);
  }

  /** Log an informational message. Extra args are stringified and appended. */
  log(message: string, ...args: unknown[]): void {
    this.logger.log(args.length ? `${message} ${args.map(formatLogValue).join(' ')}` : message);
  }

  /** Log a warning. Extra args are stringified and appended. */
  warn(message: string, ...args: unknown[]): void {
    this.logger.warn(args.length ? `${message} ${args.map(formatLogValue).join(' ')}` : message);
  }

  /** Log an error. Pass an Error object as the second argument for stack traces. */
  error(message: string, errorOrArg?: unknown, ...rest: unknown[]): void {
    if (errorOrArg instanceof Error) {
      this.logger.error(message, errorOrArg.stack);
    } else {
      const extra =
        errorOrArg !== undefined
          ? `${formatLogValue(errorOrArg)} ${rest.map(formatLogValue).join(' ')}`.trim()
          : '';
      this.logger.error(extra ? `${message} ${extra}` : message);
    }
  }
}
