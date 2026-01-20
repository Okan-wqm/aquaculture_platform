import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Add Regulatory Settings Table
 *
 * Creates regulatory_settings table for storing:
 * - Company information (name, org number, address)
 * - Maskinporten OAuth2 credentials (encrypted)
 * - Default contact information
 * - Site → Lokalitetsnummer mappings
 * - Slaughter facility approval number
 *
 * IMPORTANT: This migration follows schema-level tenant isolation:
 * 1. Creates source table in 'farm' schema (template)
 * 2. Copies to all existing tenant schemas using CREATE TABLE LIKE
 * 3. New tenants get the table automatically via MODULE_SCHEMAS
 */
export class AddRegulatorySettings1769000000000 implements MigrationInterface {
  name = 'AddRegulatorySettings1769000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // =========================================================================
    // 1. ENSURE WE'RE IN FARM SCHEMA (SOURCE SCHEMA)
    // =========================================================================
    await queryRunner.query(`SET search_path TO farm, public`);
    console.log('Set search_path to farm schema');

    // =========================================================================
    // 2. CREATE SOURCE TABLE IN FARM SCHEMA
    // =========================================================================
    const tableExists = await this.tableExistsInSchema(queryRunner, 'farm', 'regulatory_settings');

    if (!tableExists) {
      await queryRunner.query(`
        CREATE TABLE "regulatory_settings" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "tenant_id" UUID NOT NULL,

          -- Company Information
          "company_name" VARCHAR(255),
          "organisation_number" VARCHAR(20),
          "company_address" JSONB,

          -- Maskinporten OAuth2 Credentials (AES-256-CBC encrypted)
          "maskinporten_client_id" TEXT,
          "maskinporten_private_key_encrypted" TEXT,
          "maskinporten_key_id" VARCHAR(100),
          "maskinporten_environment" VARCHAR(20) DEFAULT 'TEST',

          -- Default Contact for Reports
          "default_contact_name" VARCHAR(255),
          "default_contact_email" VARCHAR(255),
          "default_contact_phone" VARCHAR(50),

          -- Site → Lokalitetsnummer Mappings (for Mattilsynet reports)
          -- Format: { "siteId": lokalitetsnummer, ... }
          "site_locality_mappings" JSONB DEFAULT '{}',

          -- Slaughter Facility (for Slakterapport)
          "slaughter_approval_number" VARCHAR(50),

          -- Metadata
          "created_at" TIMESTAMPTZ DEFAULT NOW(),
          "updated_at" TIMESTAMPTZ DEFAULT NOW(),

          -- Unique constraint per tenant
          CONSTRAINT "UQ_regulatory_settings_tenant_id" UNIQUE ("tenant_id")
        )
      `);
      console.log('Created regulatory_settings table in farm schema');

      // Create index
      await queryRunner.query(`
        CREATE INDEX "IDX_regulatory_settings_tenant_id"
        ON "regulatory_settings" ("tenant_id")
      `);
      console.log('Created index on regulatory_settings.tenant_id');
    } else {
      console.log('regulatory_settings table already exists in farm schema, skipping');
    }

    // =========================================================================
    // 3. COPY TO ALL EXISTING TENANT SCHEMAS
    // =========================================================================
    const tenantSchemas = await queryRunner.query(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name LIKE 'tenant_%'
      ORDER BY schema_name
    `);

    console.log(`Found ${tenantSchemas.length} tenant schemas to update`);

    for (const { schema_name } of tenantSchemas) {
      const tenantTableExists = await this.tableExistsInSchema(
        queryRunner,
        schema_name,
        'regulatory_settings'
      );

      if (!tenantTableExists) {
        // Create table using LIKE to copy structure including constraints and indexes
        await queryRunner.query(`
          CREATE TABLE "${schema_name}"."regulatory_settings"
          (LIKE "farm"."regulatory_settings" INCLUDING ALL)
        `);
        console.log(`Created regulatory_settings in ${schema_name}`);
      } else {
        console.log(`regulatory_settings already exists in ${schema_name}, skipping`);
      }
    }

    console.log('AddRegulatorySettings migration completed successfully');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // =========================================================================
    // 1. DROP FROM ALL TENANT SCHEMAS FIRST
    // =========================================================================
    const tenantSchemas = await queryRunner.query(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name LIKE 'tenant_%'
      ORDER BY schema_name
    `);

    console.log(`Found ${tenantSchemas.length} tenant schemas to rollback`);

    for (const { schema_name } of tenantSchemas) {
      await queryRunner.query(`
        DROP TABLE IF EXISTS "${schema_name}"."regulatory_settings"
      `);
      console.log(`Dropped regulatory_settings from ${schema_name}`);
    }

    // =========================================================================
    // 2. DROP FROM FARM SCHEMA (SOURCE)
    // =========================================================================
    await queryRunner.query(`SET search_path TO farm, public`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_regulatory_settings_tenant_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "regulatory_settings"`);
    console.log('Dropped regulatory_settings from farm schema');

    console.log('AddRegulatorySettings migration rollback completed');
  }

  /**
   * Helper to check if a table exists in a specific schema
   */
  private async tableExistsInSchema(
    queryRunner: QueryRunner,
    schemaName: string,
    tableName: string
  ): Promise<boolean> {
    const result = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = $1
        AND table_name = $2
      )
    `, [schemaName, tableName]);
    return result[0]?.exists === true;
  }
}
