import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  MigrationLogger,
  pinSearchPath,
} from '@aquaculture/backend-common/database';

/**
 * AddMissingFarmTables1789200000000
 * ============================================================================
 *
 * Creates the 42 entity-declared farm tables that no prior migration creates.
 *
 * The SourceSchemaBootstrapService cold-boot guard surfaced this on the
 * production droplet:
 *
 *   Bootstrap failed: Source schema "farm" is missing 42/74 declared tables.
 *   Refusing to fall back to runtime synchronize() per INFRA-CRITICAL-009.
 *
 * Prior to this commit the entities relied on TypeORM `synchronize: true`
 * in some pre-production environment, which masked the gap until cold-boot.
 * synchronize is explicitly off in production (`DATABASE_SYNC=false`) so
 * the schema-bootstrap guard fired correctly on the first cold deploy.
 *
 * # Tables created (alphabetical)
 *
 *   auto_rules                          chemicals
 *   chemical_sites                      chemical_types
 *   daily_feeding_executions            equipment_systems
 *   farm_audit_logs                     farm_workers
 *   feed_inventory                      feed_sites
 *   feed_type_species                   feed_types
 *   feeding_program_tanks               feeding_programs
 *   feeding_protocols                   feeding_records
 *   feeding_tables                      feeds
 *   growth_measurements                 harvest_plans
 *   harvest_records                     health_events
 *   inventory_count_items               inventory_counts
 *   maintenance_schedules               mortality_records
 *   recurring_templates                 sentinel_hub_settings
 *   site_contacts                       spare_parts
 *   sub_equipment                       sub_equipment_types
 *   supplier_sites                      supplier_types
 *   suppliers                           tank_operations
 *   tasks                               water_quality_measurements
 *   water_quality_param_equipment       water_quality_parameter_configs
 *   work_orders
 *
 * # Schema posture
 *
 * Each CREATE TABLE matches the entity's TypeORM column types 1:1:
 *   - uuid PK with gen_random_uuid()
 *   - decimal(p,s) for monetary and statistical values
 *   - jsonb for nested/dynamic configuration and history
 *   - enum types for fixed-vocabulary domains (status, severity, etc.)
 *   - timestamptz for audit columns (createdAt/updatedAt/deletedAt)
 *   - date for calendar-only date columns
 *   - text[] / simple-array text for array columns
 *
 * # Idempotency posture (R6/R8/R9/R11)
 *
 *   - CREATE TABLE IF NOT EXISTS for every table
 *   - CREATE TYPE wrapped in DO/EXCEPTION duplicate_object guard
 *   - CREATE INDEX IF NOT EXISTS for every index
 *
 * # FK posture
 *
 * Self-referential FKs and FKs to the 32 already-existing farm tables
 * (suppliers, sites, equipment, batches_v2, tanks, ponds, species,
 * feeds, feeding_programs, departments, batch_locations, etc.) are
 * NOT declared in this migration because TypeORM emits them at column
 * use site; declaring them here would risk dependency cycles between
 * tables created in this same migration. The TypeORM relations remain
 * intact at the application layer.
 *
 * Closes: docs/reviews/orphan-findings.md#ORPHAN-CRITICAL-070
 */
export class AddMissingFarmTables1789200000000 implements MigrationInterface {
  name = 'AddMissingFarmTables1789200000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'farm');

    this.logger.log('Creating 42 missing farm-service entity tables.');

    // =========================================================================
    // ENUM TYPES
    // =========================================================================

    // ── auto_rules ──────────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.auto_rules_trigger_enum AS ENUM (
          'STOCK_LOW','EXPIRY_NEAR','MAINTENANCE_DUE','SCHEDULE','LICENSE_EXPIRY','WATER_PARAM_ALERT'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── tasks / recurring_templates / auto_rules shared enums ───────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.tasks_category_enum AS ENUM (
          'FEEDING','WATER_QUALITY','HEALTH_CHECK','EQUIPMENT_MAINTENANCE','STOCK_MANAGEMENT',
          'CLEANING','REGULATORY','HARVEST','ENVIRONMENTAL','SAFETY','GENERAL'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.tasks_priority_enum AS ENUM ('URGENT','HIGH','MEDIUM','LOW');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.tasks_status_enum AS ENUM (
          'PENDING','IN_PROGRESS','COMPLETED','OVERDUE','CANCELLED'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.recurring_templates_frequency_enum AS ENUM (
          'HOURLY','DAILY','WEEKLY','BIWEEKLY','MONTHLY','CUSTOM'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── chemicals ───────────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.chemicals_type_enum AS ENUM (
          'disinfectant','treatment','water_conditioner','antibiotic','antiparasitic',
          'probiotic','vitamin','mineral','anesthetic','ph_adjuster','algaecide','other'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.chemicals_status_enum AS ENUM (
          'available','low_stock','out_of_stock','expired','discontinued'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── feeds ──────────────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.feeds_type_enum AS ENUM (
          'starter','grower','finisher','broodstock','medicated','larval','fry','other'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.feeds_floating_type_enum AS ENUM (
          'floating','sinking','slow_sinking'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.feeds_status_enum AS ENUM (
          'available','low_stock','out_of_stock','expired','discontinued'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── feeding_protocols ──────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.feeding_protocols_stage_enum AS ENUM (
          'starter','grower','finisher','broodstock','medicated','larval','fry','other'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── feed_type_species ──────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.feed_type_species_growth_stage_enum AS ENUM (
          'all','larvae','fry','fingerling','juvenile','grower','pre_adult','adult','broodstock'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.feed_type_species_recommendation_enum AS ENUM (
          'highly_recommended','recommended','suitable','conditional','not_recommended'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── feed_inventory ─────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.feed_inventory_status_enum AS ENUM (
          'available','low_stock','out_of_stock','expired','quarantine'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── feeding_programs ───────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.feeding_programs_status_enum AS ENUM (
          'draft','active','paused','completed','cancelled'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── feeding_program_tanks / daily_feeding_executions ───────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.program_equipment_type_enum AS ENUM ('tank','pond','cage');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── daily_feeding_executions ───────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.daily_feeding_executions_status_enum AS ENUM (
          'planned','in_progress','completed','skipped','partial'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── feeding_records / daily_feeding_executions feeding_method ──────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.feeding_method_enum AS ENUM (
          'manual','automatic','demand','broadcast','spot'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── feeding_tables ─────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.feeding_tables_status_enum AS ENUM (
          'draft','active','superseded','archived'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── growth_measurements ────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.growth_measurements_type_enum AS ENUM (
          'routine','transfer','grading','harvest','health_check','spot_check'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.growth_measurements_method_enum AS ENUM (
          'manual_scale','automated_scale','image_analysis','sonar','estimated'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.growth_measurements_performance_enum AS ENUM (
          'excellent','good','average','below_average','poor'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── harvest_plans ──────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.harvest_plans_status_enum AS ENUM (
          'draft','planned','approved','scheduled','in_progress','completed','cancelled','postponed'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.harvest_type_enum AS ENUM (
          'full','partial','selective','emergency','thinning'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.harvest_method_enum AS ENUM (
          'net','pump','drain','manual','crowder'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.product_form_enum AS ENUM (
          'live','fresh_whole','fresh_gutted','frozen_whole','frozen_gutted','fillet','processed'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── harvest_records ────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.harvest_records_status_enum AS ENUM (
          'in_progress','completed','quality_check','dispatched','delivered','cancelled'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.quality_grade_enum AS ENUM (
          'premium','grade_a','grade_b','grade_c','reject'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── health_events ──────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.health_event_type_enum AS ENUM (
          'disease_outbreak','symptom_observed','routine_inspection','treatment_start',
          'treatment_end','vaccination','quarantine_start','quarantine_end','mortality_event',
          'recovery','lab_result','vet_consultation'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.disease_category_enum AS ENUM (
          'bacterial','viral','parasitic','fungal','nutritional','environmental','genetic','unknown'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.health_severity_enum AS ENUM (
          'minor','moderate','severe','critical'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.health_event_status_enum AS ENUM (
          'active','monitoring','resolved','chronic','cancelled'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── farm_audit_logs ────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.audit_action_enum AS ENUM (
          'CREATE','UPDATE','DELETE','SOFT_DELETE','RESTORE','CAPACITY_BLOCKED'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── maintenance_schedules ──────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.maintenance_schedules_status_enum AS ENUM (
          'active','paused','completed','expired'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.maintenance_category_enum AS ENUM (
          'mechanical','electrical','plumbing','cleaning','lubrication','inspection',
          'calibration','filter_change','safety','general'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── work_orders ────────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.work_orders_type_enum AS ENUM (
          'preventive','corrective','emergency','inspection','calibration','cleaning',
          'installation','upgrade','routine'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.work_orders_status_enum AS ENUM (
          'draft','pending_approval','approved','scheduled','in_progress','on_hold',
          'completed','verified','cancelled'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.work_orders_priority_enum AS ENUM (
          'low','medium','high','critical'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.asset_type_enum AS ENUM (
          'tank','pond','equipment','building','vehicle','sensor','pump',
          'feeder','aerator','generator','other'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── mortality_records ──────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.mortality_cause_enum AS ENUM (
          'disease','water_quality','stress','handling','predation','cannibalism',
          'starvation','temperature','oxygen','ammonia','genetic','unknown','other'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.mortality_severity_enum AS ENUM (
          'normal','elevated','high','critical','mass'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── tank_operations ────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.operation_type_enum AS ENUM (
          'mortality','cull','transfer_out','transfer_in','harvest','sampling','adjustment',
          'cleaner_deployment','cleaner_mortality','cleaner_removal','cleaner_transfer_out','cleaner_transfer_in'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.cull_reason_enum AS ENUM (
          'small_size','deformed','sick','poor_growth','grading','other'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.mortality_reason_enum AS ENUM (
          'disease','water_quality','stress','handling','temperature','oxygen','unknown','other'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── suppliers ──────────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.suppliers_type_enum AS ENUM (
          'fry','feed','equipment','chemical','service','other'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.suppliers_status_enum AS ENUM (
          'active','inactive','suspended','blacklisted'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── spare_parts ────────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.spare_parts_status_enum AS ENUM (
          'in_stock','low_stock','out_of_stock','on_order','discontinued'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── sub_equipment ──────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.equipment_status_enum AS ENUM (
          'operational','maintenance','repair','out_of_service','decommissioned','standby',
          'active','preparing','cleaning','harvesting','fallow','quarantine'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── water_quality ─────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.water_quality_data_type_enum AS ENUM ('number','enum','boolean');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.water_quality_group_enum AS ENUM (
          'basic','nitrogen_cycle','metals','biological','organic','custom'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.water_quality_measurement_source_enum AS ENUM (
          'manual','sensor_auto','sensor_trigger','lab_analysis','calibration'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.water_quality_status_enum AS ENUM (
          'optimal','acceptable','warning','critical','unknown'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.water_quality_monitoring_frequency_enum AS ENUM (
          'continuous','hourly','daily','weekly','on_demand'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // =========================================================================
    // TABLES
    // =========================================================================

    // ── farm.auto_rules ─────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.auto_rules (
        "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"         uuid NOT NULL,
        "name"             varchar(255) NOT NULL,
        "description"      text NULL,
        "trigger"          farm.auto_rules_trigger_enum NOT NULL,
        "triggerCondition" text NOT NULL,
        "taskTitle"        varchar(255) NOT NULL,
        "taskDescription"  text NULL,
        "taskCategory"     farm.tasks_category_enum NOT NULL,
        "taskPriority"     farm.tasks_priority_enum NOT NULL,
        "assignTo"         uuid NULL,
        "isActive"         boolean NOT NULL DEFAULT true,
        "lastTriggered"    timestamptz NULL,
        "triggerCount"     integer NOT NULL DEFAULT 0,
        "createdAt"        timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"        timestamptz NOT NULL DEFAULT NOW(),
        "deletedAt"        timestamptz NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_auto_rules_tenant_active" ON farm.auto_rules ("tenantId","isActive")`);

    // ── farm.chemical_types ─────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.chemical_types (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"        varchar(100) NOT NULL,
        "code"        varchar(50) NOT NULL,
        "description" text NULL,
        "icon"        varchar(50) NULL,
        "isActive"    boolean NOT NULL DEFAULT true,
        "isSystem"    boolean NOT NULL DEFAULT false,
        "sortOrder"   integer NOT NULL DEFAULT 0,
        "createdAt"   timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"   timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_chemical_types_code" UNIQUE ("code")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_chemical_types_code_uq" ON farm.chemical_types ("code")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_chemical_types_active" ON farm.chemical_types ("isActive")`);

    // ── farm.chemicals ──────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.chemicals (
        "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"              uuid NOT NULL,
        "name"                  varchar(255) NOT NULL,
        "code"                  varchar(50) NOT NULL,
        "description"           text NULL,
        "type"                  farm.chemicals_type_enum NOT NULL DEFAULT 'other',
        "brand"                 varchar(255) NULL,
        "activeIngredient"      varchar(255) NULL,
        "concentration"         varchar(100) NULL,
        "formulation"           varchar(100) NULL,
        "supplierId"            uuid NULL,
        "status"                farm.chemicals_status_enum NOT NULL DEFAULT 'available',
        "quantity"              decimal(15,4) NOT NULL DEFAULT 0,
        "minStock"              decimal(15,4) NOT NULL DEFAULT 0,
        "unit"                  varchar(20) NOT NULL DEFAULT 'liter',
        "requiresApproval"      boolean NOT NULL DEFAULT false,
        "withdrawalPeriodDays"  integer NULL,
        "usageProtocol"         jsonb NULL,
        "safetyInfo"            jsonb NULL,
        "storageRequirements"   text NULL,
        "storage_temp_min"      decimal(5,1) NULL,
        "storage_temp_max"      decimal(5,1) NULL,
        "storage_humidity_min"  decimal(5,1) NULL,
        "storage_humidity_max"  decimal(5,1) NULL,
        "shelfLifeMonths"       integer NULL,
        "expiryDate"            date NULL,
        "usageAreas"            text NULL,
        "documents"             jsonb NULL,
        "unitPrice"             decimal(15,2) NULL,
        "currency"              varchar(3) NOT NULL DEFAULT 'TRY',
        "notes"                 text NULL,
        "isActive"              boolean NOT NULL DEFAULT true,
        "createdAt"             timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"             timestamptz NOT NULL DEFAULT NOW(),
        "createdBy"             uuid NULL,
        "updatedBy"             uuid NULL,
        "version"               integer NOT NULL DEFAULT 1,
        "isDeleted"             boolean NOT NULL DEFAULT false,
        "deletedAt"             timestamptz NULL,
        "deletedBy"             uuid NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_chemicals_tenant" ON farm.chemicals ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_chemicals_supplier" ON farm.chemicals ("supplierId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_chemicals_active" ON farm.chemicals ("isActive")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_chemicals_deleted" ON farm.chemicals ("isDeleted")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_chemicals_tenant_code" ON farm.chemicals ("tenantId","code")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_chemicals_tenant_name" ON farm.chemicals ("tenantId","name")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_chemicals_tenant_type" ON farm.chemicals ("tenantId","type")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_chemicals_tenant_status" ON farm.chemicals ("tenantId","status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_chemicals_tenant_active" ON farm.chemicals ("tenantId","isActive")`);

    // ── farm.chemical_sites ─────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.chemical_sites (
        "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"   uuid NOT NULL,
        "chemicalId" uuid NOT NULL,
        "siteId"     uuid NOT NULL,
        "isApproved" boolean NOT NULL DEFAULT true,
        "approvedBy" uuid NULL,
        "approvedAt" timestamptz NULL,
        "createdAt"  timestamptz NOT NULL DEFAULT NOW(),
        "createdBy"  uuid NULL,
        CONSTRAINT "UQ_chemical_sites_chemical_site" UNIQUE ("chemicalId","siteId")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_chemical_sites_tenant" ON farm.chemical_sites ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_chemical_sites_chemical" ON farm.chemical_sites ("chemicalId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_chemical_sites_site" ON farm.chemical_sites ("siteId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_chemical_sites_tenant_chemical" ON farm.chemical_sites ("tenantId","chemicalId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_chemical_sites_tenant_site" ON farm.chemical_sites ("tenantId","siteId")`);

    // ── farm.equipment_systems ──────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.equipment_systems (
        "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"         uuid NOT NULL,
        "equipmentId"      uuid NOT NULL,
        "systemId"         uuid NOT NULL,
        "isPrimary"        boolean NOT NULL DEFAULT false,
        "role"             varchar(50) NULL,
        "criticalityLevel" integer NOT NULL DEFAULT 3,
        "notes"            text NULL,
        "createdAt"        timestamptz NOT NULL DEFAULT NOW(),
        "createdBy"        uuid NULL,
        CONSTRAINT "UQ_equipment_systems_equipment_system" UNIQUE ("equipmentId","systemId")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_equipment_systems_tenant" ON farm.equipment_systems ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_equipment_systems_tenant_equipment" ON farm.equipment_systems ("tenantId","equipmentId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_equipment_systems_tenant_system" ON farm.equipment_systems ("tenantId","systemId")`);

    // ── farm.farm_audit_logs ────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.farm_audit_logs (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"      uuid NOT NULL,
        "entityType"    varchar(100) NOT NULL,
        "entityId"      uuid NOT NULL,
        "action"        farm.audit_action_enum NOT NULL,
        "userId"        uuid NULL,
        "userName"      varchar(255) NULL,
        "changes"       jsonb NULL,
        "metadata"      jsonb NULL,
        "createdAt"     timestamptz NOT NULL DEFAULT NOW(),
        "entityVersion" integer NULL,
        "summary"       text NULL,
        "legalHold"     boolean NOT NULL DEFAULT false
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_farm_audit_tenant" ON farm.farm_audit_logs ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_farm_audit_entity_type" ON farm.farm_audit_logs ("entityType")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_farm_audit_created_col" ON farm.farm_audit_logs ("createdAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_farm_audit_tenant_entity" ON farm.farm_audit_logs ("tenantId","entityType","entityId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_farm_audit_tenant_created" ON farm.farm_audit_logs ("tenantId","createdAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_farm_audit_created" ON farm.farm_audit_logs ("createdAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_farm_audit_tenant_action" ON farm.farm_audit_logs ("tenantId","action")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_farm_audit_tenant_user" ON farm.farm_audit_logs ("tenantId","userId")`);

    // ── farm.farm_workers ───────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.farm_workers (
        "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"       uuid NOT NULL,
        "employeeNumber" varchar NOT NULL,
        "firstName"      varchar NOT NULL,
        "lastName"       varchar NOT NULL,
        "email"          varchar NOT NULL,
        "contactInfo"    jsonb NOT NULL,
        "address"        jsonb NOT NULL,
        "dateOfBirth"    date NOT NULL,
        "nationalId"     text NOT NULL,
        "status"         varchar NOT NULL DEFAULT 'active',
        "employmentType" varchar NOT NULL,
        "department"     varchar NOT NULL,
        "position"       varchar NOT NULL,
        "hireDate"       date NOT NULL,
        "baseSalary"     decimal(12,2) NOT NULL,
        "currency"       varchar NOT NULL DEFAULT 'USD',
        "isDeleted"      boolean NOT NULL DEFAULT false,
        "isFarmWorker"   boolean NOT NULL DEFAULT false,
        "createdAt"      timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"      timestamptz NOT NULL DEFAULT NOW(),
        "createdBy"      varchar NULL,
        "version"        integer NOT NULL DEFAULT 1,
        CONSTRAINT "UQ_farm_workers_employee_number" UNIQUE ("employeeNumber")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_farm_workers_tenant_email" ON farm.farm_workers ("tenantId","email")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_farm_workers_tenant_dept" ON farm.farm_workers ("tenantId","department")`);

    // ── farm.feed_types ─────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.feed_types (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"        varchar(100) NOT NULL,
        "code"        varchar(50) NOT NULL,
        "description" text NULL,
        "icon"        varchar(50) NULL,
        "isActive"    boolean NOT NULL DEFAULT true,
        "isSystem"    boolean NOT NULL DEFAULT false,
        "sortOrder"   integer NOT NULL DEFAULT 0,
        "createdAt"   timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"   timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_feed_types_code" UNIQUE ("code")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_feed_types_code_uq" ON farm.feed_types ("code")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feed_types_active" ON farm.feed_types ("isActive")`);

    // ── farm.feeds ──────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.feeds (
        "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"              uuid NOT NULL,
        "name"                  varchar(255) NOT NULL,
        "code"                  varchar(50) NOT NULL,
        "description"           text NULL,
        "brand"                 varchar(255) NULL,
        "manufacturer"          varchar(100) NULL,
        "supplierId"            uuid NULL,
        "type"                  farm.feeds_type_enum NOT NULL DEFAULT 'grower',
        "targetSpecies"         varchar(100) NULL,
        "pelletSize"            decimal(5,2) NULL,
        "floatingType"          farm.feeds_floating_type_enum NOT NULL DEFAULT 'floating',
        "nutritionalContent"    jsonb NULL,
        "feedingTable"          jsonb NULL,
        "status"                farm.feeds_status_enum NOT NULL DEFAULT 'available',
        "quantity"              decimal(15,2) NOT NULL DEFAULT 0,
        "minStock"              decimal(15,2) NOT NULL DEFAULT 0,
        "unit"                  varchar(20) NOT NULL DEFAULT 'kg',
        "storageRequirements"   text NULL,
        "storage_temp_min"      decimal(5,1) NULL,
        "storage_temp_max"      decimal(5,1) NULL,
        "storage_humidity_min"  decimal(5,1) NULL,
        "storage_humidity_max"  decimal(5,1) NULL,
        "shelfLifeMonths"       integer NULL,
        "expiryDate"            date NULL,
        "pricePerKg"            decimal(15,2) NULL,
        "currency"              varchar(3) NOT NULL DEFAULT 'TRY',
        "documents"             jsonb NULL,
        "notes"                 text NULL,
        "pelletSizeLabel"       varchar(50) NULL,
        "productStage"          varchar(100) NULL,
        "composition"           text NULL,
        "unitSize"              varchar(100) NULL,
        "unitPrice"             decimal(15,2) NULL,
        "environmentalImpact"   jsonb NULL,
        "feedingCurve"          jsonb NULL,
        "feedingMatrix2D"       jsonb NULL,
        "min_fish_weight_g"     decimal(10,2) NULL,
        "max_fish_weight_g"     decimal(10,2) NULL,
        "isActive"              boolean NOT NULL DEFAULT true,
        "isDeleted"             boolean NOT NULL DEFAULT false,
        "deletedAt"             timestamptz NULL,
        "deletedBy"             uuid NULL,
        "createdAt"             timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"             timestamptz NOT NULL DEFAULT NOW(),
        "createdBy"             uuid NULL,
        "updatedBy"             uuid NULL,
        "version"               integer NOT NULL DEFAULT 1
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeds_tenant" ON farm.feeds ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeds_deleted" ON farm.feeds ("isDeleted")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_feeds_tenant_code" ON farm.feeds ("tenantId","code")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_feeds_tenant_name" ON farm.feeds ("tenantId","name")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeds_tenant_type" ON farm.feeds ("tenantId","type")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeds_tenant_status" ON farm.feeds ("tenantId","status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeds_tenant_target_species" ON farm.feeds ("tenantId","targetSpecies")`);

    // ── farm.feed_sites ─────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.feed_sites (
        "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"   uuid NOT NULL,
        "feedId"     uuid NOT NULL,
        "siteId"     uuid NOT NULL,
        "isApproved" boolean NOT NULL DEFAULT true,
        "approvedBy" uuid NULL,
        "approvedAt" timestamptz NULL,
        "createdAt"  timestamptz NOT NULL DEFAULT NOW(),
        "createdBy"  uuid NULL,
        CONSTRAINT "UQ_feed_sites_feed_site" UNIQUE ("feedId","siteId")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feed_sites_tenant" ON farm.feed_sites ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feed_sites_feed" ON farm.feed_sites ("feedId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feed_sites_site" ON farm.feed_sites ("siteId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feed_sites_tenant_feed" ON farm.feed_sites ("tenantId","feedId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feed_sites_tenant_site" ON farm.feed_sites ("tenantId","siteId")`);

    // ── farm.feeding_protocols ──────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.feeding_protocols (
        "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"             uuid NOT NULL,
        "name"                 varchar(255) NOT NULL,
        "description"          text NULL,
        "feedId"               uuid NULL,
        "species"              varchar(100) NOT NULL,
        "stage"                farm.feeding_protocols_stage_enum NOT NULL DEFAULT 'grower',
        "temperatureRanges"    jsonb NULL,
        "growthStageProtocols" jsonb NULL,
        "defaultSchedule"      jsonb NULL,
        "targetFcr"            decimal(4,2) NULL,
        "minDissolvedOxygen"   decimal(5,2) NULL,
        "optimalTemperature"   jsonb NULL,
        "specialConditions"    jsonb NULL,
        "notes"                text NULL,
        "isActive"             boolean NOT NULL DEFAULT true,
        "isDefault"            boolean NOT NULL DEFAULT false,
        "createdAt"            timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"            timestamptz NOT NULL DEFAULT NOW(),
        "createdBy"            uuid NULL,
        "updatedBy"            uuid NULL,
        "version"              integer NOT NULL DEFAULT 1
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_protocols_tenant" ON farm.feeding_protocols ("tenantId")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_feeding_protocols_tenant_name" ON farm.feeding_protocols ("tenantId","name")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_protocols_tenant_species" ON farm.feeding_protocols ("tenantId","species")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_protocols_tenant_stage" ON farm.feeding_protocols ("tenantId","stage")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_protocols_tenant_feed" ON farm.feeding_protocols ("tenantId","feedId")`);

    // ── farm.feed_type_species ──────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.feed_type_species (
        "id"                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"                uuid NOT NULL,
        "feedId"                  uuid NOT NULL,
        "speciesId"               uuid NOT NULL,
        "growthStage"             farm.feed_type_species_growth_stage_enum NOT NULL DEFAULT 'all',
        "recommendedWeightMinG"   decimal(10,2) NULL,
        "recommendedWeightMaxG"   decimal(10,2) NULL,
        "feedingRatePercent"      decimal(5,2) NULL,
        "feedingFrequencyPerDay"  integer NULL,
        "feedingRateConfig"       jsonb NULL,
        "recommendation"          farm.feed_type_species_recommendation_enum NOT NULL DEFAULT 'recommended',
        "priority"                integer NULL,
        "expectedPerformance"     jsonb NULL,
        "isActive"                boolean NOT NULL DEFAULT true,
        "notes"                   text NULL,
        "metadata"                jsonb NULL,
        "createdAt"               timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"               timestamptz NOT NULL DEFAULT NOW(),
        "createdBy"               uuid NULL,
        "updatedBy"               uuid NULL,
        "version"                 integer NOT NULL DEFAULT 1,
        "isDeleted"               boolean NOT NULL DEFAULT false,
        "deletedAt"               timestamptz NULL,
        "deletedBy"               uuid NULL,
        CONSTRAINT "UQ_feed_type_species_tenant_feed_species_stage" UNIQUE ("tenantId","feedId","speciesId","growthStage")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feed_type_species_tenant" ON farm.feed_type_species ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feed_type_species_active" ON farm.feed_type_species ("isActive")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feed_type_species_deleted" ON farm.feed_type_species ("isDeleted")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feed_type_species_tenant_feed" ON farm.feed_type_species ("tenantId","feedId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feed_type_species_tenant_species" ON farm.feed_type_species ("tenantId","speciesId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feed_type_species_tenant_growth_stage" ON farm.feed_type_species ("tenantId","growthStage")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feed_type_species_tenant_recommendation" ON farm.feed_type_species ("tenantId","recommendation")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feed_type_species_tenant_active" ON farm.feed_type_species ("tenantId","isActive")`);

    // ── farm.feed_inventory ─────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.feed_inventory (
        "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"            uuid NOT NULL,
        "feedId"              uuid NOT NULL,
        "siteId"              uuid NOT NULL,
        "departmentId"        uuid NULL,
        "quantityKg"          decimal(15,2) NOT NULL DEFAULT 0,
        "minStockKg"          decimal(15,2) NOT NULL DEFAULT 0,
        "status"              farm.feed_inventory_status_enum NOT NULL DEFAULT 'available',
        "lotNumber"           varchar(100) NULL,
        "manufacturingDate"   date NULL,
        "expiryDate"          date NULL,
        "receivedDate"        date NULL,
        "unitPricePerKg"      decimal(15,2) NULL,
        "totalValue"          decimal(15,2) NULL,
        "currency"            varchar(3) NULL,
        "storageLocation"     varchar(100) NULL,
        "storageTemperature"  decimal(5,1) NULL,
        "notes"               text NULL,
        "createdAt"           timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"           timestamptz NOT NULL DEFAULT NOW(),
        "createdBy"           uuid NULL,
        "updatedBy"           uuid NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feed_inventory_tenant" ON farm.feed_inventory ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feed_inventory_feed" ON farm.feed_inventory ("feedId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feed_inventory_site" ON farm.feed_inventory ("siteId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feed_inventory_tenant_feed_site" ON farm.feed_inventory ("tenantId","feedId","siteId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feed_inventory_tenant_site_status" ON farm.feed_inventory ("tenantId","siteId","status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feed_inventory_tenant_lot" ON farm.feed_inventory ("tenantId","lotNumber")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feed_inventory_feed_expiry" ON farm.feed_inventory ("feedId","expiryDate")`);

    // ── farm.feeding_programs ───────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.feeding_programs (
        "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"             uuid NOT NULL,
        "siteId"               uuid NULL,
        "name"                 varchar(200) NOT NULL,
        "code"                 varchar(50) NOT NULL,
        "description"          text NULL,
        "feedAssignments"      jsonb NOT NULL,
        "fcrTable"             jsonb NULL,
        "status"               farm.feeding_programs_status_enum NOT NULL DEFAULT 'draft',
        "startDate"            date NOT NULL,
        "endDate"              date NULL,
        "pausedAt"             timestamptz NULL,
        "activatedAt"          timestamptz NULL,
        "completedAt"          timestamptz NULL,
        "settings"             jsonb NOT NULL DEFAULT '{"autoTransition":true,"transitionBuffer":0.5,"notifyOnTransition":true,"fcrSource":"feed","defaultMealsPerDay":4}'::jsonb,
        "totalTanks"           integer NOT NULL DEFAULT 0,
        "totalFeedTransitions" integer NOT NULL DEFAULT 0,
        "totalFeedConsumed"    decimal(15,2) NULL,
        "createdBy"            uuid NOT NULL,
        "lastModifiedBy"       uuid NULL,
        "createdAt"            timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"            timestamptz NOT NULL DEFAULT NOW(),
        "deletedAt"            timestamptz NULL,
        "isDeleted"            boolean NOT NULL DEFAULT false,
        "deletedBy"            uuid NULL,
        "version"              integer NOT NULL DEFAULT 1
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_programs_tenant" ON farm.feeding_programs ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_programs_site" ON farm.feeding_programs ("siteId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_programs_status" ON farm.feeding_programs ("status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_programs_deleted" ON farm.feeding_programs ("isDeleted")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_programs_tenant_status" ON farm.feeding_programs ("tenantId","status")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_feeding_programs_tenant_code" ON farm.feeding_programs ("tenantId","code")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_programs_tenant_site" ON farm.feeding_programs ("tenantId","siteId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_programs_tenant_deleted" ON farm.feeding_programs ("tenantId","isDeleted")`);

    // ── farm.feeding_program_tanks ──────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.feeding_program_tanks (
        "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"                 uuid NOT NULL,
        "feedingProgramId"         uuid NOT NULL,
        "equipmentId"              uuid NOT NULL,
        "equipmentType"            farm.program_equipment_type_enum NOT NULL,
        "equipmentName"            varchar(200) NOT NULL,
        "equipmentCode"            varchar(50) NOT NULL,
        "currentFeedId"            uuid NULL,
        "currentFeedCode"          varchar(50) NULL,
        "currentWeightRangeIndex"  integer NULL,
        "lastFeedTransitionAt"     timestamptz NULL,
        "totalFeedTransitions"     integer NOT NULL DEFAULT 0,
        "temperatureSensorId"      uuid NULL,
        "temperatureSensorCode"    varchar(100) NULL,
        "isActive"                 boolean NOT NULL DEFAULT true,
        "addedAt"                  timestamptz NOT NULL,
        "removedAt"                timestamptz NULL,
        "notes"                    text NULL,
        "createdBy"                uuid NOT NULL,
        "lastModifiedBy"           uuid NULL,
        "createdAt"                timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"                timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT "CK_feeding_program_tanks_total_transitions_non_negative" CHECK ("totalFeedTransitions" >= 0)
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_program_tanks_tenant" ON farm.feeding_program_tanks ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_program_tanks_program" ON farm.feeding_program_tanks ("feedingProgramId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_program_tanks_equipment" ON farm.feeding_program_tanks ("equipmentId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_program_tanks_temp_sensor" ON farm.feeding_program_tanks ("temperatureSensorId")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_feeding_program_tanks_program_equipment" ON farm.feeding_program_tanks ("feedingProgramId","equipmentId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_program_tanks_tenant_program" ON farm.feeding_program_tanks ("tenantId","feedingProgramId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_program_tanks_tenant_equipment" ON farm.feeding_program_tanks ("tenantId","equipmentId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_program_tanks_tenant_active" ON farm.feeding_program_tanks ("tenantId","isActive")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_program_tanks_tenant_added" ON farm.feeding_program_tanks ("tenantId","addedAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_program_tanks_tenant_program_active" ON farm.feeding_program_tanks ("tenantId","feedingProgramId","isActive")`);

    // ── farm.daily_feeding_executions ───────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.daily_feeding_executions (
        "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"               uuid NOT NULL,
        "feedingProgramId"       uuid NOT NULL,
        "feedingProgramTankId"   uuid NOT NULL,
        "executionDate"          date NOT NULL,
        "equipmentId"            uuid NOT NULL,
        "equipmentType"          farm.program_equipment_type_enum NOT NULL,
        "equipmentName"          varchar(200) NOT NULL,
        "equipmentCode"          varchar(50) NOT NULL,
        "calculations"           jsonb NOT NULL DEFAULT '{}'::jsonb,
        "actualResults"          jsonb NULL,
        "status"                 farm.daily_feeding_executions_status_enum NOT NULL DEFAULT 'planned',
        "completedAt"            timestamptz NULL,
        "completedBy"            uuid NULL,
        "feederEquipmentId"      uuid NULL,
        "feederName"             varchar(100) NULL,
        "feedingMethod"          farm.feeding_method_enum NULL,
        "notes"                  varchar(2000) NULL,
        "skipReason"             varchar(500) NULL,
        "createdBy"              uuid NOT NULL,
        "lastModifiedBy"         uuid NULL,
        "createdAt"              timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"              timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_dfe_tenant" ON farm.daily_feeding_executions ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_dfe_program" ON farm.daily_feeding_executions ("feedingProgramId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_dfe_program_tank" ON farm.daily_feeding_executions ("feedingProgramTankId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_dfe_date" ON farm.daily_feeding_executions ("executionDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_dfe_status" ON farm.daily_feeding_executions ("status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_dfe_tenant_date" ON farm.daily_feeding_executions ("tenantId","executionDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_dfe_tenant_program_date" ON farm.daily_feeding_executions ("tenantId","feedingProgramId","executionDate")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_dfe_program_tank_date" ON farm.daily_feeding_executions ("feedingProgramTankId","executionDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_dfe_status_date" ON farm.daily_feeding_executions ("status","executionDate")`);

    // ── farm.feeding_records ────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.feeding_records (
        "id"                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"                uuid NOT NULL,
        "batchId"                 uuid NOT NULL,
        "tankId"                  uuid NULL,
        "pondId"                  uuid NULL,
        "batchLocationId"         uuid NULL,
        "feedingDate"             date NOT NULL,
        "feedingTime"             varchar(10) NOT NULL,
        "feedingSequence"         integer NOT NULL DEFAULT 1,
        "totalMealsToday"         integer NOT NULL DEFAULT 1,
        "feedId"                  uuid NOT NULL,
        "feedBatchNumber"         varchar(100) NULL,
        "plannedAmount"           decimal(10,3) NOT NULL,
        "actualAmount"            decimal(10,3) NOT NULL,
        "variance"                decimal(10,3) NOT NULL DEFAULT 0,
        "variancePercent"         decimal(5,2) NOT NULL DEFAULT 0,
        "wasteAmount"             decimal(10,3) NULL,
        "environment"             jsonb NULL,
        "fishBehavior"            jsonb NULL,
        "feedingMethod"           farm.feeding_method_enum NOT NULL DEFAULT 'manual',
        "equipmentId"             uuid NULL,
        "feedingDurationMinutes"  integer NULL,
        "feedCost"                decimal(15,2) NULL,
        "currency"                varchar(3) NULL,
        "fedBy"                   uuid NOT NULL,
        "verifiedBy"              uuid NULL,
        "verifiedAt"              timestamptz NULL,
        "notes"                   text NULL,
        "skipReason"              text NULL,
        "createdAt"               timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"               timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_records_tenant" ON farm.feeding_records ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_records_batch" ON farm.feeding_records ("batchId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_records_tank" ON farm.feeding_records ("tankId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_records_date" ON farm.feeding_records ("feedingDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_records_tenant_batch_date" ON farm.feeding_records ("tenantId","batchId","feedingDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_records_tenant_tank_date" ON farm.feeding_records ("tenantId","tankId","feedingDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_records_tenant_date" ON farm.feeding_records ("tenantId","feedingDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_records_batch_date_seq" ON farm.feeding_records ("batchId","feedingDate","feedingSequence")`);

    // ── farm.feeding_tables ─────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.feeding_tables (
        "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"             uuid NOT NULL,
        "batchId"              uuid NOT NULL,
        "feedId"               uuid NOT NULL,
        "version"              integer NOT NULL DEFAULT 1,
        "previousVersionId"    uuid NULL,
        "recalculationReason"  text NULL,
        "parameters"           jsonb NOT NULL,
        "schedule"             jsonb NOT NULL,
        "summary"              jsonb NOT NULL,
        "targetFCR"            decimal(5,3) NOT NULL,
        "actualFCR"            decimal(5,3) NULL,
        "startDate"            date NOT NULL,
        "endDate"              date NOT NULL,
        "status"               farm.feeding_tables_status_enum NOT NULL DEFAULT 'draft',
        "isActive"             boolean NOT NULL DEFAULT false,
        "notes"                text NULL,
        "calculatedAt"         timestamptz NOT NULL,
        "calculatedBy"         uuid NOT NULL,
        "createdAt"            timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"            timestamptz NOT NULL DEFAULT NOW(),
        "entityVersion"        integer NOT NULL DEFAULT 1
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_tables_tenant" ON farm.feeding_tables ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_tables_batch" ON farm.feeding_tables ("batchId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_tables_active" ON farm.feeding_tables ("isActive")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_feeding_tables_tenant_batch_version" ON farm.feeding_tables ("tenantId","batchId","version")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_tables_tenant_batch_status" ON farm.feeding_tables ("tenantId","batchId","status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_tables_tenant_status" ON farm.feeding_tables ("tenantId","status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_feeding_tables_batch_active" ON farm.feeding_tables ("batchId","isActive")`);

    // ── farm.growth_measurements ────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.growth_measurements (
        "id"                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"                uuid NOT NULL,
        "batchId"                 uuid NOT NULL,
        "tankId"                  uuid NULL,
        "pondId"                  uuid NULL,
        "measurementDate"         date NOT NULL,
        "measurementType"         farm.growth_measurements_type_enum NOT NULL DEFAULT 'routine',
        "measurementMethod"       farm.growth_measurements_method_enum NOT NULL DEFAULT 'manual_scale',
        "sampleSize"              integer NOT NULL,
        "populationSize"          integer NOT NULL,
        "samplePercent"           decimal(5,2) NOT NULL,
        "individualMeasurements"  jsonb NOT NULL,
        "statistics"              jsonb NOT NULL,
        "averageWeight"           decimal(10,2) NOT NULL,
        "averageLength"           decimal(6,2) NULL,
        "weightCV"                decimal(6,2) NOT NULL,
        "conditionFactor"         decimal(6,3) NULL,
        "growthComparison"        jsonb NULL,
        "performance"             farm.growth_measurements_performance_enum NULL,
        "fcrAnalysis"             jsonb NULL,
        "estimatedBiomass"        decimal(12,2) NOT NULL,
        "previousBiomass"         decimal(12,2) NULL,
        "biomassGain"             decimal(10,2) NULL,
        "suggestedActions"        jsonb NULL,
        "conditions"              jsonb NULL,
        "isVerified"              boolean NOT NULL DEFAULT false,
        "verifiedBy"              uuid NULL,
        "verifiedAt"              timestamptz NULL,
        "measuredBy"              uuid NOT NULL,
        "notes"                   text NULL,
        "updateBatchWeight"       boolean NOT NULL DEFAULT true,
        "isProcessed"             boolean NOT NULL DEFAULT false,
        "createdAt"               timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"               timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_growth_measurements_tenant" ON farm.growth_measurements ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_growth_measurements_batch" ON farm.growth_measurements ("batchId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_growth_measurements_date" ON farm.growth_measurements ("measurementDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_growth_measurements_tenant_batch_date" ON farm.growth_measurements ("tenantId","batchId","measurementDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_growth_measurements_tenant_date" ON farm.growth_measurements ("tenantId","measurementDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_growth_measurements_batch_date" ON farm.growth_measurements ("batchId","measurementDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_growth_measurements_batch_type" ON farm.growth_measurements ("batchId","measurementType")`);

    // ── farm.harvest_plans ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.harvest_plans (
        "id"                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"                  uuid NOT NULL,
        "planCode"                  varchar(50) NOT NULL,
        "name"                      varchar(200) NOT NULL,
        "description"               text NULL,
        "batchId"                   uuid NOT NULL,
        "status"                    farm.harvest_plans_status_enum NOT NULL DEFAULT 'draft',
        "harvestType"               farm.harvest_type_enum NOT NULL DEFAULT 'full',
        "plannedDate"               date NOT NULL,
        "confirmedDate"             date NULL,
        "windowStartDate"           date NULL,
        "windowEndDate"             date NULL,
        "criteria"                  jsonb NOT NULL,
        "harvestMethod"             farm.harvest_method_enum NULL,
        "productForm"               farm.product_form_enum NOT NULL DEFAULT 'fresh_whole',
        "estimates"                 jsonb NOT NULL,
        "financialProjection"       jsonb NULL,
        "logistics"                 jsonb NULL,
        "customerOrder"             jsonb NULL,
        "qualityRequirements"       jsonb NULL,
        "actualQuantityHarvested"   integer NULL,
        "actualBiomassHarvested"    decimal(12,2) NULL,
        "actualAvgWeight"           decimal(10,2) NULL,
        "approvedBy"                uuid NULL,
        "approvedAt"                timestamptz NULL,
        "createdBy"                 uuid NOT NULL,
        "notes"                     text NULL,
        "attachments"               text NULL,
        "createdAt"                 timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"                 timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_harvest_plans_tenant" ON farm.harvest_plans ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_harvest_plans_code" ON farm.harvest_plans ("planCode")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_harvest_plans_batch" ON farm.harvest_plans ("batchId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_harvest_plans_status" ON farm.harvest_plans ("status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_harvest_plans_planned_date" ON farm.harvest_plans ("plannedDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_harvest_plans_tenant_batch" ON farm.harvest_plans ("tenantId","batchId")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_harvest_plans_tenant_code" ON farm.harvest_plans ("tenantId","planCode")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_harvest_plans_tenant_status" ON farm.harvest_plans ("tenantId","status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_harvest_plans_tenant_planned" ON farm.harvest_plans ("tenantId","plannedDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_harvest_plans_batch_status" ON farm.harvest_plans ("batchId","status")`);

    // ── farm.harvest_records ────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.harvest_records (
        "id"                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"                    uuid NOT NULL,
        "recordCode"                  varchar(50) NOT NULL,
        "lotNumber"                   varchar(50) NOT NULL,
        "batchId"                     uuid NOT NULL,
        "harvestPlanId"               uuid NULL,
        "tankId"                      uuid NULL,
        "pondId"                      uuid NULL,
        "status"                      farm.harvest_records_status_enum NOT NULL DEFAULT 'in_progress',
        "harvestDate"                 date NOT NULL,
        "operation"                   jsonb NOT NULL,
        "method"                      farm.harvest_method_enum NOT NULL DEFAULT 'net',
        "quantityHarvested"           integer NOT NULL,
        "totalBiomass"                decimal(12,2) NOT NULL,
        "averageWeight"               decimal(10,2) NOT NULL,
        "minWeight"                   decimal(10,2) NULL,
        "maxWeight"                   decimal(10,2) NULL,
        "sizeDistribution"            jsonb NULL,
        "productForm"                 farm.product_form_enum NOT NULL DEFAULT 'fresh_whole',
        "qualityGrade"                farm.quality_grade_enum NOT NULL DEFAULT 'grade_a',
        "qualityControl"              jsonb NULL,
        "qualityApproved"             boolean NOT NULL DEFAULT false,
        "lotInfo"                     jsonb NOT NULL,
        "yieldCalculation"            jsonb NULL,
        "shipment"                    jsonb NULL,
        "customerDeliveries"          jsonb NULL,
        "totalRevenue"                decimal(15,2) NULL,
        "harvestCost"                 decimal(15,2) NULL,
        "currency"                    varchar(3) NULL,
        "mortalityDuringHarvest"      integer NULL,
        "rejectedQuantity"            decimal(10,2) NULL,
        "rejectionReason"             text NULL,
        "supervisorId"                uuid NOT NULL,
        "approvedBy"                  uuid NULL,
        "approvedAt"                  timestamptz NULL,
        "notes"                       text NULL,
        "attachments"                 text NULL,
        "updatedBy"                   uuid NULL,
        "createdAt"                   timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"                   timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_harvest_records_tenant" ON farm.harvest_records ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_harvest_records_code" ON farm.harvest_records ("recordCode")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_harvest_records_lot" ON farm.harvest_records ("lotNumber")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_harvest_records_batch" ON farm.harvest_records ("batchId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_harvest_records_status" ON farm.harvest_records ("status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_harvest_records_date" ON farm.harvest_records ("harvestDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_harvest_records_tenant_batch_date" ON farm.harvest_records ("tenantId","batchId","harvestDate")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_harvest_records_tenant_code" ON farm.harvest_records ("tenantId","recordCode")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_harvest_records_tenant_lot" ON farm.harvest_records ("tenantId","lotNumber")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_harvest_records_tenant_date" ON farm.harvest_records ("tenantId","harvestDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_harvest_records_tenant_status" ON farm.harvest_records ("tenantId","status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_harvest_records_batch_date" ON farm.harvest_records ("batchId","harvestDate")`);

    // ── farm.health_events ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.health_events (
        "id"                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"                        uuid NOT NULL,
        "batchId"                         uuid NOT NULL,
        "tankId"                          uuid NULL,
        "pondId"                          uuid NULL,
        "title"                           varchar(200) NOT NULL,
        "description"                     text NULL,
        "eventType"                       farm.health_event_type_enum NOT NULL,
        "eventDate"                       date NOT NULL,
        "eventTime"                       varchar(10) NULL,
        "diseaseCategory"                 farm.disease_category_enum NULL,
        "diseaseName"                     varchar(200) NULL,
        "severity"                        farm.health_severity_enum NOT NULL DEFAULT 'moderate',
        "symptoms"                        jsonb NULL,
        "affectedPopulation"              jsonb NULL,
        "treatment"                       jsonb NULL,
        "isUnderTreatment"                boolean NOT NULL DEFAULT false,
        "treatmentEndDate"                date NULL,
        "withdrawalPeriodDays"            integer NULL,
        "earliestHarvestDate"             date NULL,
        "isQuarantined"                   boolean NOT NULL DEFAULT false,
        "quarantineStartDate"             date NULL,
        "quarantineEndDate"               date NULL,
        "quarantineTankId"                uuid NULL,
        "labResults"                      jsonb NULL,
        "labConfirmed"                    boolean NOT NULL DEFAULT false,
        "vetConsultation"                 jsonb NULL,
        "vetNotified"                     boolean NOT NULL DEFAULT false,
        "waterQualitySnapshot"            jsonb NULL,
        "relatedWaterQualityMeasurementId" uuid NULL,
        "status"                          farm.health_event_status_enum NOT NULL DEFAULT 'active',
        "resolvedDate"                    date NULL,
        "resolutionNotes"                 text NULL,
        "parentEventId"                   uuid NULL,
        "alertIncidentId"                 uuid NULL,
        "estimatedCost"                   decimal(15,2) NULL,
        "currency"                        varchar(3) NULL,
        "reportedBy"                      uuid NOT NULL,
        "notes"                           text NULL,
        "attachments"                     text NULL,
        "followUpRequired"                boolean NOT NULL DEFAULT false,
        "nextFollowUpDate"                date NULL,
        "createdAt"                       timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"                       timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_health_events_tenant" ON farm.health_events ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_health_events_batch" ON farm.health_events ("batchId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_health_events_tank" ON farm.health_events ("tankId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_health_events_type" ON farm.health_events ("eventType")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_health_events_date" ON farm.health_events ("eventDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_health_events_status" ON farm.health_events ("status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_health_events_tenant_batch_date" ON farm.health_events ("tenantId","batchId","eventDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_health_events_tenant_type_status" ON farm.health_events ("tenantId","eventType","status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_health_events_tenant_date" ON farm.health_events ("tenantId","eventDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_health_events_batch_status" ON farm.health_events ("batchId","status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_health_events_disease_tenant" ON farm.health_events ("diseaseCategory","tenantId")`);

    // ── farm.inventory_counts ───────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.inventory_counts (
        "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id"           uuid NOT NULL,
        "count_number"        varchar(50) NOT NULL,
        "storage_location_id" uuid NOT NULL,
        "status"              varchar(30) NOT NULL DEFAULT 'PLANNED',
        "started_at"          timestamptz NULL,
        "completed_at"        timestamptz NULL,
        "approved_at"         timestamptz NULL,
        "performed_by"        uuid NOT NULL,
        "performed_by_name"   varchar(255) NULL,
        "approved_by"         uuid NULL,
        "approved_by_name"    varchar(255) NULL,
        "notes"               text NULL,
        "total_variance"      decimal(15,2) NOT NULL DEFAULT 0,
        "created_at"          timestamptz NOT NULL DEFAULT NOW(),
        "updated_at"          timestamptz NOT NULL DEFAULT NOW(),
        "version"             integer NOT NULL DEFAULT 1
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_inventory_counts_tenant" ON farm.inventory_counts ("tenant_id")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_inventory_counts_tenant_number" ON farm.inventory_counts ("tenant_id","count_number")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_inventory_counts_tenant_status" ON farm.inventory_counts ("tenant_id","status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_inventory_counts_tenant_location" ON farm.inventory_counts ("tenant_id","storage_location_id")`);

    // ── farm.inventory_count_items ──────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.inventory_count_items (
        "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id"           uuid NOT NULL,
        "inventory_count_id"  uuid NOT NULL,
        "item_type"           varchar(20) NOT NULL,
        "item_id"             uuid NOT NULL,
        "item_name"           varchar(255) NOT NULL,
        "unit"                varchar(20) NOT NULL,
        "lot_number"          varchar(100) NULL,
        "expected_quantity"   decimal(15,2) NOT NULL,
        "actual_quantity"     decimal(15,2) NULL,
        "variance"            decimal(15,2) NULL,
        "notes"               text NULL,
        "created_at"          timestamptz NOT NULL DEFAULT NOW(),
        "updated_at"          timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_inventory_count_items_tenant_count" ON farm.inventory_count_items ("tenant_id","inventory_count_id")`);

    // ── farm.maintenance_schedules ──────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.maintenance_schedules (
        "id"                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"                        uuid NOT NULL,
        "scheduleCode"                    varchar(50) NOT NULL,
        "name"                            varchar(200) NOT NULL,
        "description"                     text NULL,
        "category"                        farm.maintenance_category_enum NOT NULL DEFAULT 'general',
        "status"                          farm.maintenance_schedules_status_enum NOT NULL DEFAULT 'active',
        "assetType"                       farm.asset_type_enum NULL,
        "assetId"                         uuid NULL,
        "assetName"                       varchar(100) NULL,
        "recurrenceRule"                  jsonb NOT NULL,
        "startDate"                       date NOT NULL,
        "endDate"                         date NULL,
        "nextDueDate"                     date NULL,
        "lastExecutedDate"                date NULL,
        "currentMeterReading"             decimal(15,2) NULL,
        "lastMaintenanceMeterReading"     decimal(15,2) NULL,
        "nextMaintenanceMeterReading"     decimal(15,2) NULL,
        "estimatedDurationMinutes"        integer NULL,
        "estimatedCost"                   decimal(15,2) NULL,
        "currency"                        varchar(3) NULL,
        "checklistTemplate"               jsonb NULL,
        "requiredMaterials"               jsonb NULL,
        "instructions"                    text NULL,
        "defaultAssigneeId"               uuid NULL,
        "defaultTeamId"                   uuid NULL,
        "alertSettings"                   jsonb NULL,
        "metrics"                         jsonb NULL,
        "executionCount"                  integer NOT NULL DEFAULT 0,
        "autoGenerateWorkOrder"           boolean NOT NULL DEFAULT true,
        "generateDaysBefore"              integer NOT NULL DEFAULT 7,
        "notes"                           text NULL,
        "createdBy"                       uuid NOT NULL,
        "createdAt"                       timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"                       timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_maintenance_schedules_tenant" ON farm.maintenance_schedules ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_maintenance_schedules_code" ON farm.maintenance_schedules ("scheduleCode")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_maintenance_schedules_category" ON farm.maintenance_schedules ("category")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_maintenance_schedules_status" ON farm.maintenance_schedules ("status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_maintenance_schedules_asset_type" ON farm.maintenance_schedules ("assetType")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_maintenance_schedules_asset_id" ON farm.maintenance_schedules ("assetId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_maintenance_schedules_next_due_col" ON farm.maintenance_schedules ("nextDueDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_maintenance_schedules_tenant_status" ON farm.maintenance_schedules ("tenantId","status")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_maintenance_schedules_tenant_code" ON farm.maintenance_schedules ("tenantId","scheduleCode")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_maintenance_schedules_tenant_asset" ON farm.maintenance_schedules ("tenantId","assetType","assetId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_maintenance_schedules_tenant_next_due" ON farm.maintenance_schedules ("tenantId","nextDueDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_maintenance_schedules_tenant_category" ON farm.maintenance_schedules ("tenantId","category")`);

    // ── farm.mortality_records ──────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.mortality_records (
        "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"                 uuid NOT NULL,
        "batchId"                  uuid NOT NULL,
        "tankId"                   uuid NULL,
        "pondId"                   uuid NULL,
        "recordDate"               date NOT NULL,
        "count"                    integer NOT NULL,
        "estimatedBiomassLoss"     decimal(10,2) NULL,
        "dailyMortalityRate"       decimal(5,2) NULL,
        "cause"                    farm.mortality_cause_enum NOT NULL DEFAULT 'unknown',
        "causeDetail"              varchar(255) NULL,
        "severity"                 farm.mortality_severity_enum NOT NULL DEFAULT 'normal',
        "waterQualitySnapshot"     jsonb NULL,
        "symptoms"                 text NULL,
        "behaviorObservations"     text NULL,
        "physicalCondition"        text NULL,
        "actionsTaken"             text NULL,
        "recommendations"          text NULL,
        "labSampleTaken"           boolean NULL DEFAULT false,
        "labResults"               text NULL,
        "documents"                jsonb NULL,
        "recordedBy"               uuid NOT NULL,
        "verifiedBy"               uuid NULL,
        "verifiedAt"               timestamptz NULL,
        "notes"                    text NULL,
        "createdAt"                timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"                timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_mortality_records_tenant" ON farm.mortality_records ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_mortality_records_batch" ON farm.mortality_records ("batchId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_mortality_records_tenant_batch_date" ON farm.mortality_records ("tenantId","batchId","recordDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_mortality_records_tenant_cause" ON farm.mortality_records ("tenantId","cause")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_mortality_records_tenant_severity" ON farm.mortality_records ("tenantId","severity")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_mortality_records_batch_date" ON farm.mortality_records ("batchId","recordDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_mortality_records_tank_date" ON farm.mortality_records ("tankId","recordDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_mortality_batch_created_desc" ON farm.mortality_records ("batchId","createdAt")`);

    // ── farm.recurring_templates ────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.recurring_templates (
        "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"          uuid NOT NULL,
        "title"             varchar(255) NOT NULL,
        "description"       text NULL,
        "category"          farm.tasks_category_enum NOT NULL,
        "priority"          farm.tasks_priority_enum NOT NULL,
        "frequency"         farm.recurring_templates_frequency_enum NOT NULL,
        "frequencyDetail"   varchar NULL,
        "timezone"          varchar(64) NULL,
        "assignedTo"        uuid NOT NULL,
        "assignedToName"    varchar(255) NOT NULL,
        "location"          varchar NULL,
        "estimatedMinutes"  integer NULL,
        "checklistItems"    jsonb NOT NULL DEFAULT '[]'::jsonb,
        "isActive"          boolean NOT NULL DEFAULT true,
        "lastGenerated"     timestamptz NULL,
        "nextGeneration"    timestamptz NULL,
        "tags"              jsonb NULL DEFAULT '[]'::jsonb,
        "deletedAt"         timestamptz NULL,
        "createdAt"         timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"         timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_recurring_templates_tenant_active" ON farm.recurring_templates ("tenantId","isActive")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_recurring_templates_active_next" ON farm.recurring_templates ("isActive","nextGeneration")`);

    // ── farm.sentinel_hub_settings ──────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.sentinel_hub_settings (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"      uuid NOT NULL,
        "client_id"     text NULL,
        "client_secret" text NULL,
        "instance_id"   text NULL,
        "is_configured" boolean NOT NULL DEFAULT false,
        "last_used"     timestamptz NULL,
        "usage_count"   integer NOT NULL DEFAULT 0,
        "created_at"    timestamptz NOT NULL DEFAULT NOW(),
        "updated_at"    timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_sentinel_hub_settings_tenant" ON farm.sentinel_hub_settings ("tenantId")`);

    // ── farm.site_contacts ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.site_contacts (
        "id"        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"  uuid NOT NULL,
        "siteId"    uuid NOT NULL,
        "name"      varchar(100) NOT NULL,
        "role"      varchar(100) NULL,
        "email"     varchar(150) NULL,
        "phone"     varchar(50) NULL,
        "isPrimary" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "createdBy" uuid NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_site_contacts_tenant" ON farm.site_contacts ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_site_contacts_site" ON farm.site_contacts ("siteId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_site_contacts_tenant_site" ON farm.site_contacts ("tenantId","siteId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_site_contacts_site_primary" ON farm.site_contacts ("siteId","isPrimary")`);

    // ── farm.spare_parts ────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.spare_parts (
        "id"                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"                    uuid NOT NULL,
        "name"                        varchar(255) NOT NULL,
        "code"                        varchar(50) NOT NULL,
        "partNumber"                  varchar(100) NOT NULL,
        "description"                 text NULL,
        "equipmentTypeId"             uuid NULL,
        "compatibleEquipmentTypes"    text NULL,
        "supplierId"                  uuid NULL,
        "manufacturer"                varchar(100) NULL,
        "quantity"                    integer NOT NULL DEFAULT 0,
        "minStock"                    integer NOT NULL DEFAULT 0,
        "maxStock"                    integer NOT NULL DEFAULT 0,
        "reorderPoint"                integer NOT NULL DEFAULT 0,
        "unit"                        varchar(20) NOT NULL DEFAULT 'piece',
        "status"                      farm.spare_parts_status_enum NOT NULL DEFAULT 'in_stock',
        "location"                    jsonb NULL,
        "unitPrice"                   decimal(15,2) NULL,
        "currency"                    varchar(3) NOT NULL DEFAULT 'TRY',
        "specifications"              jsonb NULL,
        "leadTimeDays"                integer NULL,
        "lastOrderDate"               date NULL,
        "lastUsedDate"                date NULL,
        "notes"                       text NULL,
        "isActive"                    boolean NOT NULL DEFAULT true,
        "createdAt"                   timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"                   timestamptz NOT NULL DEFAULT NOW(),
        "createdBy"                   uuid NULL,
        "updatedBy"                   uuid NULL,
        "version"                     integer NOT NULL DEFAULT 1
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_spare_parts_tenant" ON farm.spare_parts ("tenantId")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_spare_parts_tenant_part_number" ON farm.spare_parts ("tenantId","partNumber")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_spare_parts_tenant_code" ON farm.spare_parts ("tenantId","code")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_spare_parts_tenant_status" ON farm.spare_parts ("tenantId","status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_spare_parts_tenant_equipment_type" ON farm.spare_parts ("tenantId","equipmentTypeId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_spare_parts_tenant_supplier" ON farm.spare_parts ("tenantId","supplierId")`);

    // ── farm.sub_equipment_types ────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.sub_equipment_types (
        "id"                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"                      varchar(100) NOT NULL,
        "code"                      varchar(50) NOT NULL,
        "description"               text NULL,
        "icon"                      varchar(50) NULL,
        "compatibleEquipmentTypes"  text NOT NULL,
        "specificationSchema"       jsonb NOT NULL,
        "isActive"                  boolean NOT NULL DEFAULT true,
        "isSystem"                  boolean NOT NULL DEFAULT false,
        "sortOrder"                 integer NOT NULL DEFAULT 0,
        "createdAt"                 timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"                 timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_sub_equipment_types_code" UNIQUE ("code")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_sub_equipment_types_code_uq" ON farm.sub_equipment_types ("code")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sub_equipment_types_active" ON farm.sub_equipment_types ("isActive")`);

    // ── farm.sub_equipment ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.sub_equipment (
        "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"            uuid NOT NULL,
        "parentEquipmentId"   uuid NOT NULL,
        "subEquipmentTypeId"  uuid NOT NULL,
        "name"                varchar(255) NOT NULL,
        "code"                varchar(50) NOT NULL,
        "description"         text NULL,
        "manufacturer"        varchar(100) NULL,
        "model"               varchar(100) NULL,
        "serialNumber"        varchar(100) NULL,
        "status"              farm.equipment_status_enum NOT NULL DEFAULT 'operational',
        "specifications"      jsonb NULL,
        "installationDate"    date NULL,
        "notes"               text NULL,
        "isActive"            boolean NOT NULL DEFAULT true,
        "createdAt"           timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"           timestamptz NOT NULL DEFAULT NOW(),
        "createdBy"           uuid NULL,
        "updatedBy"           uuid NULL,
        "version"             integer NOT NULL DEFAULT 1
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sub_equipment_tenant" ON farm.sub_equipment ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sub_equipment_parent" ON farm.sub_equipment ("parentEquipmentId")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_sub_equipment_tenant_parent_code" ON farm.sub_equipment ("tenantId","parentEquipmentId","code")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sub_equipment_tenant_status" ON farm.sub_equipment ("tenantId","status")`);

    // ── farm.supplier_types ─────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.supplier_types (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"        varchar(100) NOT NULL,
        "code"        varchar(50) NOT NULL,
        "description" text NULL,
        "icon"        varchar(50) NULL,
        "isActive"    boolean NOT NULL DEFAULT true,
        "isSystem"    boolean NOT NULL DEFAULT false,
        "sortOrder"   integer NOT NULL DEFAULT 0,
        "createdAt"   timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"   timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_supplier_types_code" UNIQUE ("code")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_supplier_types_code_uq" ON farm.supplier_types ("code")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_supplier_types_active" ON farm.supplier_types ("isActive")`);

    // ── farm.suppliers ──────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.suppliers (
        "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"       uuid NOT NULL,
        "name"           varchar(200) NOT NULL,
        "code"           varchar(20) NULL,
        "type"           farm.suppliers_type_enum NOT NULL DEFAULT 'other',
        "supplyTypes"    text NULL,
        "contactPerson"  varchar(100) NULL,
        "email"          varchar(150) NULL,
        "phone"          varchar(50) NULL,
        "website"        varchar(200) NULL,
        "address"        jsonb NULL,
        "city"           varchar(100) NULL,
        "country"        varchar(100) NULL,
        "rating"         decimal(2,1) NULL,
        "paymentTerms"   varchar(100) NULL,
        "taxId"          varchar(50) NULL,
        "products"       text NULL,
        "status"         farm.suppliers_status_enum NOT NULL DEFAULT 'active',
        "isActive"       boolean NOT NULL DEFAULT true,
        "notes"          text NULL,
        "createdAt"      timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"      timestamptz NOT NULL DEFAULT NOW(),
        "createdBy"      uuid NULL,
        "updatedBy"      uuid NULL,
        "version"        integer NOT NULL DEFAULT 1,
        "isDeleted"      boolean NOT NULL DEFAULT false,
        "deletedAt"      timestamptz NULL,
        "deletedBy"      uuid NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_suppliers_tenant" ON farm.suppliers ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_suppliers_active" ON farm.suppliers ("isActive")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_suppliers_deleted" ON farm.suppliers ("isDeleted")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_suppliers_tenant_code" ON farm.suppliers ("tenantId","code")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_suppliers_tenant_type" ON farm.suppliers ("tenantId","type")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_suppliers_tenant_status" ON farm.suppliers ("tenantId","status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_suppliers_tenant_active" ON farm.suppliers ("tenantId","isActive")`);

    // ── farm.supplier_sites ─────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.supplier_sites (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"    uuid NOT NULL,
        "supplierId"  uuid NOT NULL,
        "siteId"      uuid NOT NULL,
        "isPreferred" boolean NOT NULL DEFAULT false,
        "notes"       text NULL,
        "createdAt"   timestamptz NOT NULL DEFAULT NOW(),
        "createdBy"   uuid NULL,
        CONSTRAINT "UQ_supplier_sites_supplier_site" UNIQUE ("supplierId","siteId")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_supplier_sites_tenant" ON farm.supplier_sites ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_supplier_sites_supplier" ON farm.supplier_sites ("supplierId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_supplier_sites_site" ON farm.supplier_sites ("siteId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_supplier_sites_tenant_supplier" ON farm.supplier_sites ("tenantId","supplierId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_supplier_sites_tenant_site" ON farm.supplier_sites ("tenantId","siteId")`);

    // ── farm.tank_operations ────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.tank_operations (
        "id"                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"                    uuid NOT NULL,
        "tankId"                      uuid NOT NULL,
        "tankName"                    varchar(255) NULL,
        "tankCode"                    varchar(50) NULL,
        "sourceTankId"                uuid NULL,
        "batchId"                     uuid NOT NULL,
        "batchNumber"                 varchar(50) NULL,
        "operationType"               farm.operation_type_enum NOT NULL,
        "operationDate"               date NOT NULL,
        "quantity"                    integer NOT NULL,
        "avgWeightG"                  decimal(10,2) NULL,
        "biomassKg"                   decimal(15,2) NULL,
        "mortalityReason"             farm.mortality_reason_enum NULL,
        "mortalityDetail"             text NULL,
        "cullReason"                  farm.cull_reason_enum NULL,
        "cullDetail"                  text NULL,
        "destinationTankId"           uuid NULL,
        "destinationTankName"         varchar(255) NULL,
        "transferReason"              text NULL,
        "harvestTotalWeightKg"        decimal(15,2) NULL,
        "harvestPricePerKg"           decimal(10,2) NULL,
        "harvestBuyer"                varchar(255) NULL,
        "isCleanerFishOperation"      boolean NOT NULL DEFAULT false,
        "cleanerSpeciesName"          varchar(100) NULL,
        "cleanerBatchId"              uuid NULL,
        "preOperationState"           jsonb NULL,
        "postOperationState"          jsonb NULL,
        "notes"                       text NULL,
        "performedBy"                 uuid NOT NULL,
        "createdAt"                   timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"                   timestamptz NOT NULL DEFAULT NOW(),
        "isDeleted"                   boolean NOT NULL DEFAULT false,
        "deletedAt"                   timestamptz NULL,
        "deletedBy"                   uuid NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tank_operations_tenant" ON farm.tank_operations ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tank_operations_tank" ON farm.tank_operations ("tankId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tank_operations_batch" ON farm.tank_operations ("batchId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tank_operations_tenant_tank_date" ON farm.tank_operations ("tenantId","tankId","operationDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tank_operations_tenant_batch_date" ON farm.tank_operations ("tenantId","batchId","operationDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tank_operations_tenant_type_date" ON farm.tank_operations ("tenantId","operationType","operationDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tank_operations_tank_type" ON farm.tank_operations ("tankId","operationType")`);

    // ── farm.tasks ──────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.tasks (
        "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"              uuid NOT NULL,
        "title"                 varchar(255) NOT NULL,
        "description"           text NULL,
        "category"              farm.tasks_category_enum NOT NULL,
        "priority"              farm.tasks_priority_enum NOT NULL,
        "status"                farm.tasks_status_enum NOT NULL DEFAULT 'PENDING',
        "assignedTo"            uuid NOT NULL,
        "assignedToName"        varchar(255) NOT NULL,
        "createdBy"             uuid NOT NULL,
        "dueDate"               date NOT NULL,
        "dueTime"               time NULL,
        "siteId"                uuid NULL,
        "location"              varchar NULL,
        "estimatedMinutes"      integer NULL,
        "checklistItems"        jsonb NULL DEFAULT '[]'::jsonb,
        "notes"                 jsonb NULL DEFAULT '[]'::jsonb,
        "tags"                  jsonb NULL DEFAULT '[]'::jsonb,
        "isRecurring"           boolean NOT NULL DEFAULT false,
        "recurringTemplateId"   uuid NULL,
        "isAutoGenerated"       boolean NOT NULL DEFAULT false,
        "completedAt"           timestamptz NULL,
        "completedBy"           uuid NULL,
        "deletedAt"             timestamptz NULL,
        "createdAt"             timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"             timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tasks_tenant_assignee_status" ON farm.tasks ("tenantId","assignedTo","status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tasks_tenant_due_date" ON farm.tasks ("tenantId","dueDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tasks_tenant_status_priority" ON farm.tasks ("tenantId","status","priority")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tasks_status_due_date" ON farm.tasks ("status","dueDate")`);

    // ── farm.water_quality_parameter_configs ────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.water_quality_parameter_configs (
        "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"         uuid NOT NULL,
        "code"             varchar(50) NOT NULL,
        "name"             varchar(100) NOT NULL,
        "unit"             varchar(30) NOT NULL,
        "dataType"         farm.water_quality_data_type_enum NOT NULL DEFAULT 'number',
        "precision"        smallint NOT NULL DEFAULT 2,
        "group"            farm.water_quality_group_enum NOT NULL DEFAULT 'basic',
        "optimalMin"       decimal(10,4) NULL,
        "optimalMax"       decimal(10,4) NULL,
        "warningMin"       decimal(10,4) NULL,
        "warningMax"       decimal(10,4) NULL,
        "criticalMin"      decimal(10,4) NULL,
        "criticalMax"      decimal(10,4) NULL,
        "speciesLimits"    jsonb NULL,
        "enumValues"       text[] NULL,
        "chartColor"       varchar(9) NOT NULL DEFAULT '#3b82f6',
        "icon"             varchar(50) NULL,
        "displayOrder"     smallint NOT NULL DEFAULT 0,
        "isVisible"        boolean NOT NULL DEFAULT true,
        "isRequired"       boolean NOT NULL DEFAULT false,
        "isActive"         boolean NOT NULL DEFAULT true,
        "chartAxisGroup"   varchar(20) NULL DEFAULT 'left',
        "isQuickAccess"    boolean NOT NULL DEFAULT false,
        "templateSource"   varchar(50) NULL,
        "createdAt"        timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"        timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wq_param_configs_tenant" ON farm.water_quality_parameter_configs ("tenantId")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_wq_param_configs_tenant_code" ON farm.water_quality_parameter_configs ("tenantId","code")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wq_param_configs_tenant_active_order" ON farm.water_quality_parameter_configs ("tenantId","isActive","displayOrder")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wq_param_configs_tenant_group" ON farm.water_quality_parameter_configs ("tenantId","group")`);

    // ── farm.water_quality_param_equipment ──────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.water_quality_param_equipment (
        "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"            uuid NOT NULL,
        "parameterConfigId"   uuid NOT NULL,
        "equipmentId"         uuid NOT NULL,
        "isActive"            boolean NOT NULL DEFAULT true,
        "monitoringFrequency" farm.water_quality_monitoring_frequency_enum NOT NULL DEFAULT 'on_demand',
        "sensorId"            uuid NULL,
        "alertEnabled"        boolean NOT NULL DEFAULT true,
        "notes"               text NULL,
        "createdAt"           timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"           timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wq_param_equipment_tenant" ON farm.water_quality_param_equipment ("tenantId")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_wq_param_equipment_tenant_param_equipment" ON farm.water_quality_param_equipment ("tenantId","parameterConfigId","equipmentId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wq_param_equipment_tenant_equipment" ON farm.water_quality_param_equipment ("tenantId","equipmentId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wq_param_equipment_tenant_param" ON farm.water_quality_param_equipment ("tenantId","parameterConfigId")`);

    // ── farm.water_quality_measurements ─────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.water_quality_measurements (
        "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"                 uuid NOT NULL,
        "tankId"                   uuid NULL,
        "pondId"                   uuid NULL,
        "siteId"                   uuid NULL,
        "equipmentId"              uuid NULL,
        "measuredAt"               timestamptz NOT NULL,
        "source"                   farm.water_quality_measurement_source_enum NOT NULL DEFAULT 'manual',
        "measuredBy"               uuid NULL,
        "parameters"               jsonb NOT NULL,
        "temperature"              decimal(5,2) NULL,
        "dissolvedOxygen"          decimal(5,2) NULL,
        "pH"                       decimal(4,2) NULL,
        "ammonia"                  decimal(6,3) NULL,
        "nitrite"                  decimal(6,3) NULL,
        "overallStatus"            farm.water_quality_status_enum NOT NULL DEFAULT 'unknown',
        "summary"                  jsonb NULL,
        "hasAlarm"                 boolean NOT NULL DEFAULT false,
        "alertRuleId"              uuid NULL,
        "alertIncidentId"          uuid NULL,
        "sensorInfo"               jsonb NULL,
        "relatedSensorReadingId"   uuid NULL,
        "batchId"                  uuid NULL,
        "idempotencyKey"           uuid NULL,
        "notes"                    text NULL,
        "weatherConditions"        text NULL,
        "createdAt"                timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"                timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wq_measurements_tenant" ON farm.water_quality_measurements ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wq_measurements_tank" ON farm.water_quality_measurements ("tankId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wq_measurements_pond" ON farm.water_quality_measurements ("pondId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wq_measurements_equipment" ON farm.water_quality_measurements ("equipmentId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wq_measurements_measured_at" ON farm.water_quality_measurements ("measuredAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wq_measurements_status" ON farm.water_quality_measurements ("overallStatus")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wq_measurements_related_sensor_reading" ON farm.water_quality_measurements ("relatedSensorReadingId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wq_measurements_idempotency" ON farm.water_quality_measurements ("idempotencyKey")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wq_measurements_tenant_tank_measured" ON farm.water_quality_measurements ("tenantId","tankId","measuredAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wq_measurements_tenant_pond_measured" ON farm.water_quality_measurements ("tenantId","pondId","measuredAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wq_measurements_tenant_measured" ON farm.water_quality_measurements ("tenantId","measuredAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wq_measurements_tank_measured" ON farm.water_quality_measurements ("tankId","measuredAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wq_measurements_status_tenant" ON farm.water_quality_measurements ("overallStatus","tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wq_measurements_tenant_equipment_measured" ON farm.water_quality_measurements ("tenantId","equipmentId","measuredAt")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_wq_measurements_tenant_idempotency" ON farm.water_quality_measurements ("tenantId","idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`);

    // ── farm.work_orders ────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.work_orders (
        "id"                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"                    uuid NOT NULL,
        "workOrderCode"               varchar(50) NOT NULL,
        "title"                       varchar(200) NOT NULL,
        "description"                 text NULL,
        "type"                        farm.work_orders_type_enum NOT NULL DEFAULT 'corrective',
        "status"                      farm.work_orders_status_enum NOT NULL DEFAULT 'draft',
        "priority"                    farm.work_orders_priority_enum NOT NULL DEFAULT 'medium',
        "assetType"                   farm.asset_type_enum NULL,
        "assetId"                     uuid NULL,
        "relatedAsset"                jsonb NULL,
        "plannedStartDate"            date NULL,
        "dueDate"                     date NULL,
        "estimatedDurationMinutes"    integer NULL,
        "actualStartTime"             timestamptz NULL,
        "actualEndTime"               timestamptz NULL,
        "actualDurationMinutes"       integer NULL,
        "assignedTo"                  uuid NULL,
        "assignedTeamId"              uuid NULL,
        "createdBy"                   uuid NOT NULL,
        "approvedBy"                  uuid NULL,
        "approvedAt"                  timestamptz NULL,
        "checklist"                   jsonb NULL,
        "checklistProgress"           integer NULL,
        "usedMaterials"               jsonb NULL,
        "laborRecords"                jsonb NULL,
        "estimatedCost"               decimal(15,2) NULL,
        "costSummary"                 jsonb NULL,
        "currency"                    varchar(3) NULL,
        "maintenanceScheduleId"       uuid NULL,
        "isRecurring"                 boolean NOT NULL DEFAULT false,
        "completionNotes"             text NULL,
        "completedBy"                 uuid NULL,
        "completedAt"                 timestamptz NULL,
        "verifiedBy"                  uuid NULL,
        "verifiedAt"                  timestamptz NULL,
        "relatedHealthEventId"        uuid NULL,
        "relatedAlertIncidentId"      uuid NULL,
        "notes"                       text NULL,
        "attachments"                 text NULL,
        "createdAt"                   timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt"                   timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_work_orders_tenant" ON farm.work_orders ("tenantId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_work_orders_code" ON farm.work_orders ("workOrderCode")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_work_orders_type" ON farm.work_orders ("type")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_work_orders_status" ON farm.work_orders ("status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_work_orders_priority" ON farm.work_orders ("priority")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_work_orders_asset_type" ON farm.work_orders ("assetType")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_work_orders_asset_id" ON farm.work_orders ("assetId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_work_orders_planned_start" ON farm.work_orders ("plannedStartDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_work_orders_due_date" ON farm.work_orders ("dueDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_work_orders_assigned_to" ON farm.work_orders ("assignedTo")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_work_orders_tenant_status_priority" ON farm.work_orders ("tenantId","status","priority")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_work_orders_tenant_code" ON farm.work_orders ("tenantId","workOrderCode")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_work_orders_tenant_assignee_status" ON farm.work_orders ("tenantId","assignedTo","status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_work_orders_tenant_due_date" ON farm.work_orders ("tenantId","dueDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_work_orders_tenant_type" ON farm.work_orders ("tenantId","type")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_work_orders_asset_type_id_tenant" ON farm.work_orders ("assetType","assetId","tenantId")`);

    this.logger.log('Created 42 farm-service tables + enum types + indexes.');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    this.logger.warn(
      'Dropping 42 farm-service tables. ' +
        'Intended for ephemeral test environments only.',
    );

    await pinSearchPath(queryRunner, 'farm');

    // Drop tables in reverse-dependency order. Tables with FKs to others
    // (e.g. feed_inventory → feeds → suppliers) drop first.
    await queryRunner.query(`DROP TABLE IF EXISTS farm.work_orders`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.water_quality_measurements`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.water_quality_param_equipment`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.water_quality_parameter_configs`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.tasks`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.tank_operations`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.supplier_sites`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.suppliers`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.supplier_types`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.sub_equipment`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.sub_equipment_types`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.spare_parts`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.site_contacts`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.sentinel_hub_settings`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.recurring_templates`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.mortality_records`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.maintenance_schedules`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.inventory_count_items`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.inventory_counts`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.health_events`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.harvest_records`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.harvest_plans`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.growth_measurements`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.feeding_tables`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.feeding_records`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.daily_feeding_executions`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.feeding_program_tanks`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.feeding_programs`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.feed_inventory`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.feed_type_species`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.feeding_protocols`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.feed_sites`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.feeds`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.feed_types`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.farm_workers`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.farm_audit_logs`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.equipment_systems`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.chemical_sites`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.chemicals`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.chemical_types`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.auto_rules`);

    // Drop enum types
    await queryRunner.query(`DROP TYPE IF EXISTS farm.water_quality_monitoring_frequency_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.water_quality_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.water_quality_measurement_source_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.water_quality_group_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.water_quality_data_type_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.equipment_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.spare_parts_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.suppliers_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.suppliers_type_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.mortality_reason_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.cull_reason_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.operation_type_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.mortality_severity_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.mortality_cause_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.asset_type_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.work_orders_priority_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.work_orders_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.work_orders_type_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.maintenance_category_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.maintenance_schedules_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.audit_action_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.health_event_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.health_severity_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.disease_category_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.health_event_type_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.quality_grade_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.harvest_records_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.product_form_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.harvest_method_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.harvest_type_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.harvest_plans_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.growth_measurements_performance_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.growth_measurements_method_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.growth_measurements_type_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.feeding_tables_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.feeding_method_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.daily_feeding_executions_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.program_equipment_type_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.feeding_programs_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.feed_inventory_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.feed_type_species_recommendation_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.feed_type_species_growth_stage_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.feeding_protocols_stage_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.feeds_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.feeds_floating_type_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.feeds_type_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.chemicals_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.chemicals_type_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.recurring_templates_frequency_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.tasks_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.tasks_priority_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.tasks_category_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm.auto_rules_trigger_enum`);
  }
}
