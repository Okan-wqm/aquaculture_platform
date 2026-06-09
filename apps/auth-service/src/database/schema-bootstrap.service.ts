import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

interface MissingColumnRow {
  table_name?: unknown;
  column_name?: unknown;
}

/**
 * AuthSchemaBootstrapService verifies migration-owned auth schema state before
 * the service accepts traffic. It deliberately performs no DDL; missing columns
 * or ledgers are deployment failures owned by db-migrate/auth migrations.
 */
@Injectable()
export class AuthSchemaBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(AuthSchemaBootstrapService.name);

  constructor(private readonly dataSource: DataSource) {}

  private rowsFromQuery<T extends object>(value: unknown): T[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter(
      (row): row is T =>
        typeof row === 'object' && row !== null && !Array.isArray(row),
    );
  }

  private readIdentifier(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureSchemaColumns();
    } catch (error) {
      this.logger.error('Auth schema verification failed', error);
      throw error;
    }
  }

  /**
   * Ensures all required migration outputs exist in the auth schema.
   */
  private async ensureSchemaColumns(): Promise<void> {
    const missingColumns = this.rowsFromQuery<MissingColumnRow>(await this.dataSource.query(
      `
      SELECT expected.table_name, expected.column_name
      FROM (
        VALUES
          ('users', 'accessType'),
          ('mobile_user_settings', 'allowed_features')
      ) AS expected(table_name, column_name)
      WHERE NOT EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = 'auth'
          AND c.table_name = expected.table_name
          AND c.column_name = expected.column_name
      )
      ORDER BY expected.table_name, expected.column_name
      `,
    ));
    if (missingColumns.length > 0) {
      const rendered = missingColumns
        .map((row) => `auth.${this.readIdentifier(row.table_name)}.${this.readIdentifier(row.column_name)}`)
        .join(', ');
      throw new Error(`Auth schema is missing migration-owned column(s): ${rendered}`);
    }

    const missingTables = this.rowsFromQuery<Record<string, unknown>>(await this.dataSource.query(
      `
      SELECT expected.table_name
      FROM (VALUES ('migrations')) AS expected(table_name)
      WHERE NOT EXISTS (
        SELECT 1
        FROM information_schema.tables t
        WHERE t.table_schema = 'auth'
          AND t.table_name = expected.table_name
          AND t.table_type = 'BASE TABLE'
      )
      `,
    ));
    if (missingTables.length > 0) {
      throw new Error('Auth schema migration ledger is missing; run db-migrate before auth-service');
    }

    this.logger.log('Auth schema verification completed successfully');
  }
}
