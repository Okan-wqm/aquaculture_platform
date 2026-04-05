import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common';

/**
 * Migration: Create Dynamic Sensor Types Infrastructure
 *
 * Creates the tables needed to make the sensor module industry-agnostic:
 * - sensor_type_definitions: Custom sensor type definitions per tenant
 * - industry_templates: Pre-built industry configurations (aquaculture, cold_chain, greenhouse)
 * - channel_detection_log: AI channel detection audit trail
 *
 * Also adds type_definition_id FK to sensors table and seeds system data.
 */
export class CreateDynamicSensorTypes1740200000000 implements MigrationInterface {
  private readonly logger = new MigrationLogger('CreateDynamicSensorTypes1740200000000');
  name = 'CreateDynamicSensorTypes1740200000000';

  /** System tenant ID for built-in sensor type definitions */
  private readonly SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const schema: Array<{ current_schema: string }> = await queryRunner.query(`SELECT current_schema()`);
    this.logger.log('Running CreateDynamicSensorTypes migration in schema:', schema);

    // ──────────────────────────────────────────────
    // 1. Create sensor_type_definitions table
    // ──────────────────────────────────────────────
    if (!(await this.tableExists(queryRunner, 'sensor_type_definitions'))) {
      await queryRunner.query(`
        CREATE TABLE "sensor_type_definitions" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "tenant_id" UUID NOT NULL,
          "type_key" VARCHAR(100) NOT NULL,
          "display_name" VARCHAR(200) NOT NULL,
          "description" TEXT,
          "icon" VARCHAR(100),
          "category" VARCHAR(100),
          "industry" VARCHAR(100),
          "is_system" BOOLEAN NOT NULL DEFAULT false,
          "default_channels" JSONB DEFAULT '[]'::jsonb,
          "metadata" JSONB DEFAULT '{}'::jsonb,
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT "UQ_sensor_type_definitions_tenant_key" UNIQUE ("tenant_id", "type_key")
        )
      `);
      this.logger.log('Created sensor_type_definitions table');

      // Indexes
      await queryRunner.query(`
        CREATE INDEX "IDX_sensor_type_defs_tenant"
        ON "sensor_type_definitions" ("tenant_id")
      `);
      await queryRunner.query(`
        CREATE INDEX "IDX_sensor_type_defs_type_key"
        ON "sensor_type_definitions" ("type_key")
      `);
      await queryRunner.query(`
        CREATE INDEX "IDX_sensor_type_defs_category"
        ON "sensor_type_definitions" ("category")
        WHERE "category" IS NOT NULL
      `);
      await queryRunner.query(`
        CREATE INDEX "IDX_sensor_type_defs_industry"
        ON "sensor_type_definitions" ("industry")
        WHERE "industry" IS NOT NULL
      `);
      await queryRunner.query(`
        CREATE INDEX "IDX_sensor_type_defs_system"
        ON "sensor_type_definitions" ("is_system")
        WHERE "is_system" = true
      `);
      this.logger.log('Created indexes for sensor_type_definitions');

      // Updated_at trigger
      await queryRunner.query(`
        CREATE OR REPLACE FUNCTION update_sensor_type_definitions_updated_at()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await queryRunner.query(`
        DROP TRIGGER IF EXISTS trigger_sensor_type_definitions_updated_at ON "sensor_type_definitions";
        CREATE TRIGGER trigger_sensor_type_definitions_updated_at
        BEFORE UPDATE ON "sensor_type_definitions"
        FOR EACH ROW
        EXECUTE FUNCTION update_sensor_type_definitions_updated_at()
      `);
      this.logger.log('Created updated_at trigger for sensor_type_definitions');
    } else {
      this.logger.log('sensor_type_definitions table already exists, skipping creation');
    }

    // ──────────────────────────────────────────────
    // 2. Create industry_templates table
    // ──────────────────────────────────────────────
    if (!(await this.tableExists(queryRunner, 'industry_templates'))) {
      await queryRunner.query(`
        CREATE TABLE "industry_templates" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "template_key" VARCHAR(100) NOT NULL,
          "display_name" VARCHAR(200) NOT NULL,
          "description" TEXT,
          "icon" VARCHAR(100),
          "sensor_types" JSONB NOT NULL DEFAULT '[]'::jsonb,
          "dashboard_layout" JSONB,
          "alert_presets" JSONB,
          "is_active" BOOLEAN NOT NULL DEFAULT true,
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT "UQ_industry_templates_key" UNIQUE ("template_key")
        )
      `);
      this.logger.log('Created industry_templates table');

      // Indexes
      await queryRunner.query(`
        CREATE INDEX "IDX_industry_templates_active"
        ON "industry_templates" ("is_active")
        WHERE "is_active" = true
      `);
      await queryRunner.query(`
        CREATE INDEX "IDX_industry_templates_key"
        ON "industry_templates" ("template_key")
      `);
      this.logger.log('Created indexes for industry_templates');
    } else {
      this.logger.log('industry_templates table already exists, skipping creation');
    }

    // ──────────────────────────────────────────────
    // 3. Create channel_detection_log table
    // ──────────────────────────────────────────────
    if (!(await this.tableExists(queryRunner, 'channel_detection_log'))) {
      // Create table without FK first — sensors table may not exist in
      // the current schema (e.g. public). FK is added conditionally below.
      await queryRunner.query(`
        CREATE TABLE "channel_detection_log" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "tenant_id" UUID NOT NULL,
          "sensor_id" UUID NOT NULL,
          "raw_sample" JSONB NOT NULL,
          "ai_analysis" JSONB NOT NULL,
          "proposed_channels" JSONB NOT NULL,
          "user_action" VARCHAR(20),
          "final_channels" JSONB,
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      // Only add FK if sensors table exists in the current schema
      if (await this.tableExists(queryRunner, 'sensors')) {
        await queryRunner.query(`
          ALTER TABLE "channel_detection_log"
          ADD CONSTRAINT "FK_channel_detection_log_sensor"
            FOREIGN KEY ("sensor_id")
            REFERENCES "sensors" ("id")
            ON DELETE CASCADE
        `);
      } else {
        this.logger.log('sensors table not found in current schema, skipping FK constraint for channel_detection_log');
      }
      this.logger.log('Created channel_detection_log table');

      // Indexes
      await queryRunner.query(`
        CREATE INDEX "IDX_channel_detection_log_tenant"
        ON "channel_detection_log" ("tenant_id")
      `);
      await queryRunner.query(`
        CREATE INDEX "IDX_channel_detection_log_sensor"
        ON "channel_detection_log" ("sensor_id")
      `);
      await queryRunner.query(`
        CREATE INDEX "IDX_channel_detection_log_created"
        ON "channel_detection_log" ("created_at" DESC)
      `);
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS "IDX_channel_detection_log_pending"
        ON "channel_detection_log" ("sensor_id", "tenant_id")
        WHERE "user_action" IS NULL
      `);
      this.logger.log('Created indexes for channel_detection_log');
    } else {
      this.logger.log('channel_detection_log table already exists, skipping creation');
    }

    // ──────────────────────────────────────────────
    // 4. Add type_definition_id to sensors table
    // ──────────────────────────────────────────────
    if (await this.tableExists(queryRunner, 'sensors')) {
      if (!(await this.columnExists(queryRunner, 'sensors', 'type_definition_id'))) {
        await queryRunner.query(`
          ALTER TABLE "sensors"
          ADD COLUMN "type_definition_id" UUID
        `);
        await queryRunner.query(`
          ALTER TABLE "sensors"
          ADD CONSTRAINT "FK_sensors_type_definition"
          FOREIGN KEY ("type_definition_id")
          REFERENCES "sensor_type_definitions" ("id")
          ON DELETE SET NULL
        `);
        await queryRunner.query(`
          CREATE INDEX "IDX_sensors_type_definition"
          ON "sensors" ("type_definition_id")
          WHERE "type_definition_id" IS NOT NULL
        `);
        this.logger.log('Added type_definition_id column to sensors table');
      } else {
        this.logger.log('type_definition_id column already exists on sensors, skipping');
      }
    } else {
      this.logger.log('sensors table not found in current schema, skipping type_definition_id column addition');
    }

    // ──────────────────────────────────────────────
    // 5. Seed industry templates
    // ──────────────────────────────────────────────
    await this.seedIndustryTemplates(queryRunner);

    // ──────────────────────────────────────────────
    // 6. Seed system sensor type definitions
    // ──────────────────────────────────────────────
    await this.seedSystemSensorTypes(queryRunner);

    // ──────────────────────────────────────────────
    // 7. Backfill type_definition_id for existing sensors
    // ──────────────────────────────────────────────
    if (await this.tableExists(queryRunner, 'sensors')) {
      await this.backfillSensorTypeDefinitions(queryRunner);
    } else {
      this.logger.log('sensors table not found in current schema, skipping backfill');
    }

    this.logger.log('CreateDynamicSensorTypes migration completed successfully');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove FK and column from sensors (reverse of step 4)
    if (await this.columnExists(queryRunner, 'sensors', 'type_definition_id')) {
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sensors_type_definition"`);
      await queryRunner.query(`ALTER TABLE "sensors" DROP CONSTRAINT IF EXISTS "FK_sensors_type_definition"`);
      await queryRunner.query(`ALTER TABLE "sensors" DROP COLUMN "type_definition_id"`);
      this.logger.log('Dropped type_definition_id column from sensors');
    }

    // Drop channel_detection_log (reverse of step 3)
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_channel_detection_log_pending"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_channel_detection_log_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_channel_detection_log_sensor"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_channel_detection_log_tenant"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "channel_detection_log"`);
    this.logger.log('Dropped channel_detection_log table');

    // Drop industry_templates (reverse of step 2)
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_industry_templates_key"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_industry_templates_active"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "industry_templates"`);
    this.logger.log('Dropped industry_templates table');

    // Drop sensor_type_definitions (reverse of step 1)
    await queryRunner.query(`DROP TRIGGER IF EXISTS trigger_sensor_type_definitions_updated_at ON "sensor_type_definitions"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS update_sensor_type_definitions_updated_at()`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sensor_type_defs_system"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sensor_type_defs_industry"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sensor_type_defs_category"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sensor_type_defs_type_key"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sensor_type_defs_tenant"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sensor_type_definitions"`);
    this.logger.log('Dropped sensor_type_definitions table');

    this.logger.log('Rolled back CreateDynamicSensorTypes migration');
  }

  // ──────────────────────────────────────────────
  // Seed: Industry Templates
  // ──────────────────────────────────────────────
  private async seedIndustryTemplates(queryRunner: QueryRunner): Promise<void> {
    const templates = [
      {
        template_key: 'aquaculture',
        display_name: 'Aquaculture & Fish Farming',
        description: 'Complete sensor setup for fish farms, shrimp ponds, and aquaculture facilities. Includes water quality, feeding, and environmental monitoring.',
        icon: 'fish',
        sensor_types: JSON.stringify([
          { type_key: 'temperature', required: true },
          { type_key: 'ph', required: true },
          { type_key: 'dissolved_oxygen', required: true },
          { type_key: 'salinity', required: true },
          { type_key: 'ammonia', required: true },
          { type_key: 'nitrite', required: true },
          { type_key: 'nitrate', required: false },
          { type_key: 'turbidity', required: false },
          { type_key: 'water_level', required: false },
          { type_key: 'orp', required: false },
          { type_key: 'flow_rate', required: false },
          { type_key: 'multi_parameter', required: false },
        ]),
        dashboard_layout: JSON.stringify({
          sections: [
            { title: 'Water Quality', sensors: ['temperature', 'ph', 'dissolved_oxygen', 'salinity'] },
            { title: 'Nutrients', sensors: ['ammonia', 'nitrite', 'nitrate'] },
            { title: 'Environment', sensors: ['turbidity', 'water_level', 'orp'] },
          ],
        }),
        alert_presets: JSON.stringify({
          temperature: { warning: { low: 18, high: 32 }, critical: { low: 15, high: 35 } },
          ph: { warning: { low: 6.5, high: 8.5 }, critical: { low: 6.0, high: 9.0 } },
          dissolved_oxygen: { warning: { low: 4.0 }, critical: { low: 3.0 } },
          ammonia: { warning: { high: 0.5 }, critical: { high: 1.0 } },
        }),
      },
      {
        template_key: 'cold_chain',
        display_name: 'Cold Chain & Refrigeration',
        description: 'Temperature and humidity monitoring for cold storage, refrigerated transport, and food processing facilities.',
        icon: 'snowflake',
        sensor_types: JSON.stringify([
          { type_key: 'temperature', required: true },
          { type_key: 'co2', required: false },
          { type_key: 'flow_rate', required: false },
          { type_key: 'conductivity', required: false },
          { type_key: 'chlorine', required: false },
        ]),
        dashboard_layout: JSON.stringify({
          sections: [
            { title: 'Temperature Zones', sensors: ['temperature'] },
            { title: 'Air Quality', sensors: ['co2'] },
            { title: 'Utilities', sensors: ['flow_rate', 'conductivity', 'chlorine'] },
          ],
        }),
        alert_presets: JSON.stringify({
          temperature: { warning: { low: -22, high: -16 }, critical: { low: -25, high: -14 } },
          co2: { warning: { high: 1000 }, critical: { high: 2000 } },
        }),
      },
      {
        template_key: 'greenhouse',
        display_name: 'Greenhouse & Horticulture',
        description: 'Environmental monitoring for greenhouses, vertical farms, and horticultural operations. Covers climate, irrigation, and nutrient management.',
        icon: 'leaf',
        sensor_types: JSON.stringify([
          { type_key: 'temperature', required: true },
          { type_key: 'co2', required: true },
          { type_key: 'ph', required: false },
          { type_key: 'conductivity', required: true },
          { type_key: 'water_level', required: false },
          { type_key: 'flow_rate', required: false },
          { type_key: 'nitrate', required: false },
        ]),
        dashboard_layout: JSON.stringify({
          sections: [
            { title: 'Climate', sensors: ['temperature', 'co2'] },
            { title: 'Irrigation', sensors: ['ph', 'conductivity', 'water_level', 'flow_rate'] },
            { title: 'Nutrients', sensors: ['nitrate'] },
          ],
        }),
        alert_presets: JSON.stringify({
          temperature: { warning: { low: 15, high: 35 }, critical: { low: 10, high: 40 } },
          co2: { warning: { low: 300, high: 1200 }, critical: { low: 200, high: 1500 } },
          conductivity: { warning: { low: 0.5, high: 3.0 }, critical: { low: 0.3, high: 4.0 } },
        }),
      },
    ];

    for (const tpl of templates) {
      // Idempotent: skip if already exists
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const exists: Array<{ count: string }> = await queryRunner.query(
        `SELECT COUNT(*) as count FROM "industry_templates" WHERE "template_key" = $1`,
        [tpl.template_key],
      );
      if (parseInt(exists[0]?.count || '0', 10) > 0) {
        this.logger.log(`Industry template '${tpl.template_key}' already exists, skipping`);
        continue;
      }

      await queryRunner.query(
        `INSERT INTO "industry_templates"
          ("template_key", "display_name", "description", "icon", "sensor_types", "dashboard_layout", "alert_presets")
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
        [
          tpl.template_key,
          tpl.display_name,
          tpl.description,
          tpl.icon,
          tpl.sensor_types,
          tpl.dashboard_layout,
          tpl.alert_presets,
        ],
      );
      this.logger.log(`Seeded industry template: ${tpl.template_key}`);
    }
  }

  // ──────────────────────────────────────────────
  // Seed: System Sensor Type Definitions
  // ──────────────────────────────────────────────
  private async seedSystemSensorTypes(queryRunner: QueryRunner): Promise<void> {
    const systemTypes = [
      {
        type_key: 'temperature',
        display_name: 'Temperature',
        description: 'Measures temperature in liquid or air environments',
        icon: 'thermometer',
        category: 'environmental',
        industry: null,
        default_channels: JSON.stringify([
          { channelKey: 'temperature', unit: '\u00b0C', unitSymbol: '\u00b0C', displayLabel: 'Temperature', physicalMin: -40, physicalMax: 100 },
        ]),
      },
      {
        type_key: 'ph',
        display_name: 'pH',
        description: 'Measures the acidity or alkalinity of a solution',
        icon: 'flask',
        category: 'water_quality',
        industry: null,
        default_channels: JSON.stringify([
          { channelKey: 'ph', unit: 'pH', unitSymbol: 'pH', displayLabel: 'pH Level', physicalMin: 0, physicalMax: 14 },
        ]),
      },
      {
        type_key: 'dissolved_oxygen',
        display_name: 'Dissolved Oxygen',
        description: 'Measures the concentration of dissolved oxygen in water',
        icon: 'droplet',
        category: 'water_quality',
        industry: 'aquaculture',
        default_channels: JSON.stringify([
          { channelKey: 'dissolved_oxygen', unit: 'mg/L', unitSymbol: 'mg/L', displayLabel: 'Dissolved Oxygen', physicalMin: 0, physicalMax: 20 },
          { channelKey: 'do_saturation', unit: '%', unitSymbol: '%', displayLabel: 'DO Saturation', physicalMin: 0, physicalMax: 200 },
        ]),
      },
      {
        type_key: 'salinity',
        display_name: 'Salinity',
        description: 'Measures the salt concentration in water',
        icon: 'waves',
        category: 'water_quality',
        industry: 'aquaculture',
        default_channels: JSON.stringify([
          { channelKey: 'salinity', unit: 'ppt', unitSymbol: 'ppt', displayLabel: 'Salinity', physicalMin: 0, physicalMax: 50 },
        ]),
      },
      {
        type_key: 'ammonia',
        display_name: 'Ammonia',
        description: 'Measures ammonia concentration in water',
        icon: 'alert-triangle',
        category: 'water_quality',
        industry: 'aquaculture',
        default_channels: JSON.stringify([
          { channelKey: 'ammonia', unit: 'mg/L', unitSymbol: 'mg/L', displayLabel: 'Total Ammonia Nitrogen', physicalMin: 0, physicalMax: 10 },
        ]),
      },
      {
        type_key: 'nitrite',
        display_name: 'Nitrite',
        description: 'Measures nitrite concentration in water',
        icon: 'alert-triangle',
        category: 'water_quality',
        industry: 'aquaculture',
        default_channels: JSON.stringify([
          { channelKey: 'nitrite', unit: 'mg/L', unitSymbol: 'mg/L', displayLabel: 'Nitrite', physicalMin: 0, physicalMax: 10 },
        ]),
      },
      {
        type_key: 'nitrate',
        display_name: 'Nitrate',
        description: 'Measures nitrate concentration in water',
        icon: 'beaker',
        category: 'water_quality',
        industry: null,
        default_channels: JSON.stringify([
          { channelKey: 'nitrate', unit: 'mg/L', unitSymbol: 'mg/L', displayLabel: 'Nitrate', physicalMin: 0, physicalMax: 100 },
        ]),
      },
      {
        type_key: 'turbidity',
        display_name: 'Turbidity',
        description: 'Measures water clarity and suspended particles',
        icon: 'eye-off',
        category: 'water_quality',
        industry: null,
        default_channels: JSON.stringify([
          { channelKey: 'turbidity', unit: 'NTU', unitSymbol: 'NTU', displayLabel: 'Turbidity', physicalMin: 0, physicalMax: 1000 },
        ]),
      },
      {
        type_key: 'water_level',
        display_name: 'Water Level',
        description: 'Measures water level or depth',
        icon: 'ruler',
        category: 'environmental',
        industry: null,
        default_channels: JSON.stringify([
          { channelKey: 'water_level', unit: 'm', unitSymbol: 'm', displayLabel: 'Water Level', physicalMin: 0, physicalMax: 10 },
        ]),
      },
      {
        type_key: 'multi_parameter',
        display_name: 'Multi-Parameter',
        description: 'Multi-parameter probe that measures multiple water quality parameters simultaneously',
        icon: 'activity',
        category: 'water_quality',
        industry: null,
        default_channels: JSON.stringify([
          { channelKey: 'temperature', unit: '\u00b0C', unitSymbol: '\u00b0C', displayLabel: 'Temperature', physicalMin: -5, physicalMax: 50 },
          { channelKey: 'ph', unit: 'pH', unitSymbol: 'pH', displayLabel: 'pH', physicalMin: 0, physicalMax: 14 },
          { channelKey: 'dissolved_oxygen', unit: 'mg/L', unitSymbol: 'mg/L', displayLabel: 'Dissolved Oxygen', physicalMin: 0, physicalMax: 20 },
          { channelKey: 'conductivity', unit: '\u00b5S/cm', unitSymbol: '\u00b5S/cm', displayLabel: 'Conductivity', physicalMin: 0, physicalMax: 100000 },
        ]),
      },
      {
        type_key: 'flow_rate',
        display_name: 'Flow Rate',
        description: 'Measures the flow rate of liquid through pipes or channels',
        icon: 'git-merge',
        category: 'process',
        industry: null,
        default_channels: JSON.stringify([
          { channelKey: 'flow_rate', unit: 'L/min', unitSymbol: 'L/min', displayLabel: 'Flow Rate', physicalMin: 0, physicalMax: 1000 },
          { channelKey: 'total_volume', unit: 'L', unitSymbol: 'L', displayLabel: 'Total Volume', physicalMin: 0, physicalMax: null },
        ]),
      },
      {
        type_key: 'conductivity',
        display_name: 'Conductivity',
        description: 'Measures the electrical conductivity of a solution',
        icon: 'zap',
        category: 'water_quality',
        industry: null,
        default_channels: JSON.stringify([
          { channelKey: 'conductivity', unit: '\u00b5S/cm', unitSymbol: '\u00b5S/cm', displayLabel: 'Conductivity', physicalMin: 0, physicalMax: 100000 },
          { channelKey: 'tds', unit: 'mg/L', unitSymbol: 'mg/L', displayLabel: 'Total Dissolved Solids', physicalMin: 0, physicalMax: 50000 },
        ]),
      },
      {
        type_key: 'orp',
        display_name: 'ORP',
        description: 'Measures oxidation-reduction potential of a solution',
        icon: 'battery-charging',
        category: 'water_quality',
        industry: null,
        default_channels: JSON.stringify([
          { channelKey: 'orp', unit: 'mV', unitSymbol: 'mV', displayLabel: 'ORP', physicalMin: -2000, physicalMax: 2000 },
        ]),
      },
      {
        type_key: 'chlorine',
        display_name: 'Chlorine',
        description: 'Measures free and total chlorine concentration',
        icon: 'shield',
        category: 'water_quality',
        industry: null,
        default_channels: JSON.stringify([
          { channelKey: 'free_chlorine', unit: 'mg/L', unitSymbol: 'mg/L', displayLabel: 'Free Chlorine', physicalMin: 0, physicalMax: 10 },
          { channelKey: 'total_chlorine', unit: 'mg/L', unitSymbol: 'mg/L', displayLabel: 'Total Chlorine', physicalMin: 0, physicalMax: 20 },
        ]),
      },
      {
        type_key: 'co2',
        display_name: 'CO2',
        description: 'Measures carbon dioxide concentration in air or dissolved in water',
        icon: 'cloud',
        category: 'environmental',
        industry: null,
        default_channels: JSON.stringify([
          { channelKey: 'co2', unit: 'ppm', unitSymbol: 'ppm', displayLabel: 'CO2 Concentration', physicalMin: 0, physicalMax: 5000 },
        ]),
      },
    ];

    for (const sensorType of systemTypes) {
      // Idempotent: skip if already exists
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const exists: Array<{ count: string }> = await queryRunner.query(
        `SELECT COUNT(*) as count FROM "sensor_type_definitions"
         WHERE "tenant_id" = $1 AND "type_key" = $2`,
        [this.SYSTEM_TENANT_ID, sensorType.type_key],
      );
      if (parseInt(exists[0]?.count || '0', 10) > 0) {
        this.logger.log(`System sensor type '${sensorType.type_key}' already exists, skipping`);
        continue;
      }

      await queryRunner.query(
        `INSERT INTO "sensor_type_definitions"
          ("tenant_id", "type_key", "display_name", "description", "icon", "category", "industry", "is_system", "default_channels")
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8::jsonb)`,
        [
          this.SYSTEM_TENANT_ID,
          sensorType.type_key,
          sensorType.display_name,
          sensorType.description,
          sensorType.icon,
          sensorType.category,
          sensorType.industry,
          sensorType.default_channels,
        ],
      );
      this.logger.log(`Seeded system sensor type: ${sensorType.type_key}`);
    }
  }

  // ──────────────────────────────────────────────
  // Backfill: Link existing sensors to type definitions
  // ──────────────────────────────────────────────
  private async backfillSensorTypeDefinitions(queryRunner: QueryRunner): Promise<void> {
    // Update sensors that have a `type` matching a system sensor type definition
    // and don't already have a type_definition_id set
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result: Array<{ updated: string }> = await queryRunner.query(`
      WITH updated AS (
        UPDATE "sensors" s
        SET "type_definition_id" = std.id
        FROM "sensor_type_definitions" std
        WHERE std."tenant_id" = $1
          AND std."is_system" = true
          AND std."type_key" = s."type"::text
          AND s."type_definition_id" IS NULL
        RETURNING s.id
      )
      SELECT COUNT(*) as updated FROM updated
    `, [this.SYSTEM_TENANT_ID]);

    const count = parseInt(result[0]?.updated || '0', 10);
    this.logger.log(`Backfilled type_definition_id for ${count} existing sensors`);
  }

  // ──────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────
  private async tableExists(queryRunner: QueryRunner, tableName: string): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result: Array<{ exists: boolean }> = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_name = $1
        AND table_schema = current_schema()
      )
    `, [tableName]);
    return result[0]?.exists === true;
  }

  private async columnExists(queryRunner: QueryRunner, tableName: string, columnName: string): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result: Array<{ exists: boolean }> = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = $1
        AND column_name = $2
        AND table_schema = current_schema()
      )
    `, [tableName, columnName]);
    return result[0]?.exists === true;
  }
}
