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
 *   import { MigrationLogger } from '@aquaculture/backend-common';
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

export class MigrationLogger {
  private readonly logger: Logger;

  constructor(migrationName: string) {
    // Prefix ensures log lines are instantly identifiable as migration output
    // in aggregated logs alongside service logs from the same binary.
    this.logger = new Logger(`Migration:${migrationName}`);
  }

  log(message: string): void {
    this.logger.log(message);
  }

  warn(message: string): void {
    this.logger.warn(message);
  }

  error(message: string, error?: unknown): void {
    if (error instanceof Error) {
      this.logger.error(message, error.stack);
    } else {
      this.logger.error(message);
    }
  }
}
