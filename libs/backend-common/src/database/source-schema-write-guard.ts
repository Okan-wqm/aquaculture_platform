import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

/**
 * SourceSchemaWriteGuardService
 *
 * Database-level defense-in-depth for tenant isolation.
 * Installs PostgreSQL BEFORE triggers on non-reference tables in source schemas
 * that RAISE EXCEPTION on any INSERT/UPDATE/DELETE attempt.
 *
 * Even if application code has bugs (missing request context, wrong search_path),
 * the database itself will reject writes to source schema tables.
 *
 * Reference data tables (seed/lookup data) are EXCLUDED because they need to be
 * writable for initial seeding and updates.
 *
 * The trigger function uses ERRCODE 'P0999' which can be caught and handled
 * specifically by application error handlers.
 */
@Injectable()
export class SourceSchemaWriteGuardService implements OnModuleInit {
  private readonly logger = new Logger(SourceSchemaWriteGuardService.name);

  async onModuleInit(): Promise<void> {
    try {
      await this.installWriteGuards();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to install source schema write guards (non-fatal): ${msg}`);
    }
  }

  /**
   * Install write guard triggers on all non-reference tables in the service's source schema.
   */
  async installWriteGuards(): Promise<void> {
    this.logger.warn(
      'Source schema write guard installation is disabled in runtime services; ' +
        'aqua-db-migrate owns source-schema trigger hardening.',
    );
  }

  /**
   * Temporarily disable write guards for DDL operations (e.g., synchronize).
   * Call this before SourceSchemaBootstrapService.synchronize() if needed.
   */
  async disableGuards(sourceSchema: string, tables: string[]): Promise<void> {
    void sourceSchema;
    void tables;
    throw new Error(
      'Runtime services cannot disable source schema write guards. ' +
        'aqua-db-migrate owns source-schema trigger hardening and DDL windows.',
    );
  }

  /**
   * Re-enable write guards after DDL operations.
   */
  async enableGuards(sourceSchema: string, tables: string[]): Promise<void> {
    void sourceSchema;
    void tables;
    throw new Error(
      'Runtime services cannot enable source schema write guards. ' +
        'aqua-db-migrate owns source-schema trigger hardening and DDL windows.',
    );
  }
}
