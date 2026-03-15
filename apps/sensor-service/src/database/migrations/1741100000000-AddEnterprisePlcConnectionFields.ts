import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Add Enterprise PLC Connection Fields
 *
 * Adds new columns to the `plc_connections` table for enterprise OPC UA features:
 * - Certificate authentication (clientCertificate, clientPrivateKey, serverCertificate)
 * - Connection timeouts (connectTimeoutMs, requestTimeoutMs)
 * - Reconnection settings (autoReconnect, maxReconnectAttempts, reconnectDelayMs,
 *   maxReconnectDelayMs, keepAliveIntervalMs)
 * - Failover (failoverEndpointUrl)
 * - Updated securityPolicy default to 'None'
 *
 * Note: TypeORM uses camelCase column names in this project (no explicit `name:`
 * overrides in @Column decorators). All column names in SQL are quoted camelCase.
 *
 * This migration is idempotent: it checks for column existence before adding.
 * It also handles multi-tenant schemas by operating on the current search_path.
 */
export class AddEnterprisePlcConnectionFields1741100000000
  implements MigrationInterface
{
  name = 'AddEnterprisePlcConnectionFields1741100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Log current schema for debugging
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const schema: Array<{ current_schema: string }> = await queryRunner.query(
      `SELECT current_schema()`,
    );
    console.log(
      'Running AddEnterprisePlcConnectionFields migration in schema:',
      schema,
    );

    // Only proceed if plc_connections table exists in the current schema
    if (!(await this.tableExists(queryRunner, 'plc_connections'))) {
      console.log(
        'plc_connections table does not exist in current schema, skipping migration',
      );
      return;
    }

    // ──────────────────────────────────────────────
    // 1. Certificate authentication columns
    // ──────────────────────────────────────────────
    if (
      !(await this.columnExists(
        queryRunner,
        'plc_connections',
        'clientCertificate',
      ))
    ) {
      await queryRunner.query(`
        ALTER TABLE "plc_connections"
        ADD COLUMN "clientCertificate" text
      `);
      console.log('Added clientCertificate column');
    } else {
      console.log('clientCertificate column already exists, skipping');
    }

    if (
      !(await this.columnExists(
        queryRunner,
        'plc_connections',
        'clientPrivateKey',
      ))
    ) {
      await queryRunner.query(`
        ALTER TABLE "plc_connections"
        ADD COLUMN "clientPrivateKey" text
      `);
      console.log('Added clientPrivateKey column');
    } else {
      console.log('clientPrivateKey column already exists, skipping');
    }

    if (
      !(await this.columnExists(
        queryRunner,
        'plc_connections',
        'serverCertificate',
      ))
    ) {
      await queryRunner.query(`
        ALTER TABLE "plc_connections"
        ADD COLUMN "serverCertificate" text
      `);
      console.log('Added serverCertificate column');
    } else {
      console.log('serverCertificate column already exists, skipping');
    }

    // ──────────────────────────────────────────────
    // 2. Connection timeout columns
    // ──────────────────────────────────────────────
    if (
      !(await this.columnExists(
        queryRunner,
        'plc_connections',
        'connectTimeoutMs',
      ))
    ) {
      await queryRunner.query(`
        ALTER TABLE "plc_connections"
        ADD COLUMN "connectTimeoutMs" integer NOT NULL DEFAULT 5000
      `);
      console.log('Added connectTimeoutMs column');
    } else {
      console.log('connectTimeoutMs column already exists, skipping');
    }

    if (
      !(await this.columnExists(
        queryRunner,
        'plc_connections',
        'requestTimeoutMs',
      ))
    ) {
      await queryRunner.query(`
        ALTER TABLE "plc_connections"
        ADD COLUMN "requestTimeoutMs" integer NOT NULL DEFAULT 60000
      `);
      console.log('Added requestTimeoutMs column');
    } else {
      console.log('requestTimeoutMs column already exists, skipping');
    }

    // ──────────────────────────────────────────────
    // 3. Reconnection settings columns
    // ──────────────────────────────────────────────
    if (
      !(await this.columnExists(
        queryRunner,
        'plc_connections',
        'autoReconnect',
      ))
    ) {
      await queryRunner.query(`
        ALTER TABLE "plc_connections"
        ADD COLUMN "autoReconnect" boolean NOT NULL DEFAULT true
      `);
      console.log('Added autoReconnect column');
    } else {
      console.log('autoReconnect column already exists, skipping');
    }

    if (
      !(await this.columnExists(
        queryRunner,
        'plc_connections',
        'maxReconnectAttempts',
      ))
    ) {
      await queryRunner.query(`
        ALTER TABLE "plc_connections"
        ADD COLUMN "maxReconnectAttempts" integer NOT NULL DEFAULT -1
      `);
      console.log('Added maxReconnectAttempts column');
    } else {
      console.log('maxReconnectAttempts column already exists, skipping');
    }

    if (
      !(await this.columnExists(
        queryRunner,
        'plc_connections',
        'reconnectDelayMs',
      ))
    ) {
      await queryRunner.query(`
        ALTER TABLE "plc_connections"
        ADD COLUMN "reconnectDelayMs" integer NOT NULL DEFAULT 1000
      `);
      console.log('Added reconnectDelayMs column');
    } else {
      console.log('reconnectDelayMs column already exists, skipping');
    }

    if (
      !(await this.columnExists(
        queryRunner,
        'plc_connections',
        'maxReconnectDelayMs',
      ))
    ) {
      await queryRunner.query(`
        ALTER TABLE "plc_connections"
        ADD COLUMN "maxReconnectDelayMs" integer NOT NULL DEFAULT 30000
      `);
      console.log('Added maxReconnectDelayMs column');
    } else {
      console.log('maxReconnectDelayMs column already exists, skipping');
    }

    if (
      !(await this.columnExists(
        queryRunner,
        'plc_connections',
        'keepAliveIntervalMs',
      ))
    ) {
      await queryRunner.query(`
        ALTER TABLE "plc_connections"
        ADD COLUMN "keepAliveIntervalMs" integer NOT NULL DEFAULT 5000
      `);
      console.log('Added keepAliveIntervalMs column');
    } else {
      console.log('keepAliveIntervalMs column already exists, skipping');
    }

    // ──────────────────────────────────────────────
    // 4. Failover column
    // ──────────────────────────────────────────────
    if (
      !(await this.columnExists(
        queryRunner,
        'plc_connections',
        'failoverEndpointUrl',
      ))
    ) {
      await queryRunner.query(`
        ALTER TABLE "plc_connections"
        ADD COLUMN "failoverEndpointUrl" varchar
      `);
      console.log('Added failoverEndpointUrl column');
    } else {
      console.log('failoverEndpointUrl column already exists, skipping');
    }

    // ──────────────────────────────────────────────
    // 5. Update securityPolicy default to 'None'
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "plc_connections"
      ALTER COLUMN "securityPolicy" SET DEFAULT 'None'
    `);
    console.log('Updated securityPolicy default to None');

    console.log(
      'AddEnterprisePlcConnectionFields migration completed successfully',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const schema: Array<{ current_schema: string }> = await queryRunner.query(
      `SELECT current_schema()`,
    );
    console.log(
      'Reverting AddEnterprisePlcConnectionFields migration in schema:',
      schema,
    );

    if (!(await this.tableExists(queryRunner, 'plc_connections'))) {
      console.log(
        'plc_connections table does not exist in current schema, skipping revert',
      );
      return;
    }

    // Revert securityPolicy default (original entity had no explicit default
    // for securityPolicy, but the column definition was: varchar, nullable, default 'None'.
    // The default was already 'None' before this migration, so no change needed
    // on revert. If the previous default was different, adjust here.)

    // Drop failover column
    if (
      await this.columnExists(
        queryRunner,
        'plc_connections',
        'failoverEndpointUrl',
      )
    ) {
      await queryRunner.query(`
        ALTER TABLE "plc_connections"
        DROP COLUMN "failoverEndpointUrl"
      `);
      console.log('Dropped failoverEndpointUrl column');
    }

    // Drop reconnection columns (reverse order)
    if (
      await this.columnExists(
        queryRunner,
        'plc_connections',
        'keepAliveIntervalMs',
      )
    ) {
      await queryRunner.query(`
        ALTER TABLE "plc_connections"
        DROP COLUMN "keepAliveIntervalMs"
      `);
      console.log('Dropped keepAliveIntervalMs column');
    }

    if (
      await this.columnExists(
        queryRunner,
        'plc_connections',
        'maxReconnectDelayMs',
      )
    ) {
      await queryRunner.query(`
        ALTER TABLE "plc_connections"
        DROP COLUMN "maxReconnectDelayMs"
      `);
      console.log('Dropped maxReconnectDelayMs column');
    }

    if (
      await this.columnExists(
        queryRunner,
        'plc_connections',
        'reconnectDelayMs',
      )
    ) {
      await queryRunner.query(`
        ALTER TABLE "plc_connections"
        DROP COLUMN "reconnectDelayMs"
      `);
      console.log('Dropped reconnectDelayMs column');
    }

    if (
      await this.columnExists(
        queryRunner,
        'plc_connections',
        'maxReconnectAttempts',
      )
    ) {
      await queryRunner.query(`
        ALTER TABLE "plc_connections"
        DROP COLUMN "maxReconnectAttempts"
      `);
      console.log('Dropped maxReconnectAttempts column');
    }

    if (
      await this.columnExists(
        queryRunner,
        'plc_connections',
        'autoReconnect',
      )
    ) {
      await queryRunner.query(`
        ALTER TABLE "plc_connections"
        DROP COLUMN "autoReconnect"
      `);
      console.log('Dropped autoReconnect column');
    }

    // Drop connection timeout columns
    if (
      await this.columnExists(
        queryRunner,
        'plc_connections',
        'requestTimeoutMs',
      )
    ) {
      await queryRunner.query(`
        ALTER TABLE "plc_connections"
        DROP COLUMN "requestTimeoutMs"
      `);
      console.log('Dropped requestTimeoutMs column');
    }

    if (
      await this.columnExists(
        queryRunner,
        'plc_connections',
        'connectTimeoutMs',
      )
    ) {
      await queryRunner.query(`
        ALTER TABLE "plc_connections"
        DROP COLUMN "connectTimeoutMs"
      `);
      console.log('Dropped connectTimeoutMs column');
    }

    // Drop certificate columns
    if (
      await this.columnExists(
        queryRunner,
        'plc_connections',
        'serverCertificate',
      )
    ) {
      await queryRunner.query(`
        ALTER TABLE "plc_connections"
        DROP COLUMN "serverCertificate"
      `);
      console.log('Dropped serverCertificate column');
    }

    if (
      await this.columnExists(
        queryRunner,
        'plc_connections',
        'clientPrivateKey',
      )
    ) {
      await queryRunner.query(`
        ALTER TABLE "plc_connections"
        DROP COLUMN "clientPrivateKey"
      `);
      console.log('Dropped clientPrivateKey column');
    }

    if (
      await this.columnExists(
        queryRunner,
        'plc_connections',
        'clientCertificate',
      )
    ) {
      await queryRunner.query(`
        ALTER TABLE "plc_connections"
        DROP COLUMN "clientCertificate"
      `);
      console.log('Dropped clientCertificate column');
    }

    console.log(
      'Reverted AddEnterprisePlcConnectionFields migration successfully',
    );
  }

  // ──────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────
  private async tableExists(
    queryRunner: QueryRunner,
    tableName: string,
  ): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result: Array<{ exists: boolean }> = await queryRunner.query(
      `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_name = $1
        AND table_schema = current_schema()
      )
    `,
      [tableName],
    );
    return result[0]?.exists === true;
  }

  private async columnExists(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string,
  ): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result: Array<{ exists: boolean }> = await queryRunner.query(
      `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = $1
        AND column_name = $2
        AND table_schema = current_schema()
      )
    `,
      [tableName, columnName],
    );
    return result[0]?.exists === true;
  }
}
