// TODO: SchemaManagerService is ~1,400 lines and should be split into smaller focused services.
// Recommended decomposition:
//   - SchemaProvisioningService  (createTenantSchema, dropTenantSchema, schemaExists)
//   - SchemaSearchPathService    (setTenantSearchPath, setTenantSearchPathInTransaction, resetSearchPath)
//   - SchemaMigrationService     (migrateDataToTenantSchema, copyReferenceDataTable)
//   - SchemaTimescaleService     (createSensorMetricsHypertable, createContinuousAggregates, etc.)
//   - SchemaIntrospectionService (listTenantSchemas, getSchemaTableCount, validateModuleSchemas)
// Keep MODULE_SCHEMAS and ModuleSchema interface in a separate schemas.constants.ts file.

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';

/**
 * Module schema definitions - tables for each module
 */
export interface ModuleSchema {
  moduleName: string;
  tables: string[];
  sourceSchema: string;
  /** Tables containing reference/lookup data to copy into new tenant schemas */
  referenceDataTables?: string[];
}

/**
 * Supported modules and their table definitions.
 *
 * MAINTENANCE CONTRACT:
 * - Every table registered in a NestJS entity (with @Entity decorator) for a module MUST be
 *   listed in the corresponding MODULE_SCHEMAS entry BEFORE the entity is deployed to production.
 * - When adding a new table: add it to the `tables` array of the relevant module here.
 * - When removing a table: remove it from both the entity definitions AND this list, then create
 *   a migration to drop the column/table from existing tenant schemas.
 * - Reference data tables (lookup / seed data) must also be listed in `referenceDataTables` so
 *   they are copied into every new tenant schema on provisioning.
 * - Call `SchemaManagerService.validateModuleSchemas()` in integration tests to detect drift
 *   between this list and the actual entity definitions.
 */
export const MODULE_SCHEMAS: ModuleSchema[] = [
  {
    moduleName: 'sensor',
    sourceSchema: 'sensor', // Tables are in sensor schema, will be copied to tenant schema
    referenceDataTables: ['sensor_protocols', 'sensor_type_definitions', 'industry_templates'],
    tables: [
      // Core sensor entities
      'sensors',
      'sensor_readings',
      'sensor_metrics',
      'sensor_data_channels',
      'sensor_protocols',
      'processes',

      // VFD (Variable Frequency Drive) entities
      'vfd_devices',
      'vfd_readings',
      'vfd_register_mappings',

      // Dashboard & Edge devices
      'dashboard_layouts',
      'edge_devices',
      'device_io_configs',

      // PLC control entities
      'plc_connections',
      'plc_alarms',
      'plc_telemetry',
      'feeding_parameters',

      // Automation (IEC 61131-3) entities
      'automation_programs',
      'program_steps',
      'program_transitions',
      'program_variables',
      'step_actions',

      // Dynamic sensor type system
      'sensor_type_definitions',
      'industry_templates',
      'channel_detection_log',

      // Edge Gateway - Self-Registration & Deployment
      'tenant_provisioning_keys',
      'device_events',
      'deployment_logs',

      // SCADA & Unified Tag entities
      'scada_packages',
      'scada_deploy_logs',
      'unified_tags',

      // LoRa & Device Groups
      'lora_devices',
      'device_groups',
      'device_group_members',

      // Audit
      'sensor_audit_logs',
    ],
  },
  {
    moduleName: 'farm',
    sourceSchema: 'farm', // Tables are in farm schema, will be copied to tenant schema
    referenceDataTables: ['equipment_types', 'sub_equipment_types', 'supplier_types', 'chemical_types', 'feed_types'],
    tables: [
      // Core entities
      'farms',
      'sites',
      'departments',
      'ponds',
      'tanks',
      'tank_allocations',
      'tank_batches',
      'tank_operations',

      // Batch management
      'batches',
      'batches_v2',
      'batch_documents',
      'batch_feed_assignments',
      'batch_locations',
      'species',

      // Equipment hierarchy
      'systems',
      'sub_systems',
      'equipment_types',
      'equipment',
      'equipment_systems',
      'sub_equipment_types',
      'sub_equipment',
      'feeder_calibrations',

      // Maintenance
      'maintenance_schedules',
      'work_orders',
      'spare_parts',

      // Feed management
      'feed_types',
      'feed_type_species',
      'feeds',
      'feed_inventory',
      'feed_sites',
      'feeding_protocols',
      'feeding_records',
      'feeding_tables',
      'feeding_programs',
      'feeding_program_tanks',
      'daily_feeding_executions',

      // Chemical management
      'chemical_types',
      'chemicals',
      'chemical_sites',

      // Production tracking
      'growth_measurements',
      'mortality_records',
      'water_quality_measurements',
      'water_quality_parameter_configs',
      'water_quality_param_equipment',
      'health_events',
      'harvest_plans',
      'harvest_records',

      // Suppliers
      'supplier_types',
      'suppliers',
      'supplier_sites',

      // Site contacts
      'site_contacts',

      // Supporting tables
      'code_sequences',
      'farm_audit_logs',

      // Storage & Stock Management
      'storage_locations',
      'consumables',
      'storage_inventory',
      'stock_movements',
      'purchase_orders',
      'purchase_order_items',
      'inventory_counts',
      'inventory_count_items',

      // Regulatory settings (Maskinporten credentials, company info)
      'regulatory_settings',
      'sentinel_hub_settings',

      // Weather & Marine observations
      'weather_observations',
      'marine_observations',
      'weather_settings',

      // Task management & Automation
      'tasks',
      'auto_rules',
      'recurring_templates',

      // Workers
      'farm_workers',
    ],
  },
  {
    moduleName: 'hr',
    sourceSchema: 'hr', // Tables are in hr schema, will be copied to tenant schema
    referenceDataTables: ['leave_types', 'certification_types', 'shifts'],
    tables: [
      // Core Employee & Payroll
      'employees',
      'payrolls',
      'departments_hr',

      // Leave Management
      'leave_types',
      'leave_balances',
      'leave_requests',

      // Attendance & Scheduling
      'shifts',
      'schedules',
      'schedule_entries',
      'scheduling_settings',
      'attendance_records',

      // Weekly Planning
      'weekly_plans',
      'weekly_plan_entries',

      // Holidays
      'holidays',

      // Training
      'training_courses',
      'training_enrollments',

      // Certifications (Aquaculture-specific)
      'certification_types',
      'employee_certifications',

      // Performance Management
      'goals',
      'performance_reviews',
      'employee_kpis',

      // Aquaculture-specific
      'work_areas',
      'work_rotations',
      'safety_training_records',
    ],
  },
  {
    moduleName: 'hydroponics',
    sourceSchema: 'hydroponics',
    referenceDataTables: [],
    tables: [
      'hydroponics_config',
    ],
  },
  {
    moduleName: 'alert',
    sourceSchema: 'alert',
    referenceDataTables: [],
    tables: [
      'alert_rules',
      'alert_incidents',
      'escalation_policies',
      'alert_history',
      'alert_audit_log',
    ],
  },
  {
    moduleName: 'ai',
    sourceSchema: 'ai',
    referenceDataTables: [],
    tables: [
      'agent_conversations',
      'tenant_agent_configs',
      'tool_execution_audit',
    ],
  },
  {
    moduleName: 'messaging',
    sourceSchema: 'messaging',
    referenceDataTables: [],
    tables: [
      // Core messaging tables (migration 1711800000000)
      'channels',
      'channel_members',
      'messages',
      'message_attachments',
      'message_receipts',
      'message_reactions',
      'pinned_messages',
      'messaging_outbox',
      // AI tables (migration 1711800000001)
      'message_analysis',
      'message_entity_references',
      'knowledge_entries',
      'embeddings_metadata',
      // Compliance tables (migration 1711800000003)
      'retention_policies',
      'legal_holds',
      'compliance_audit_log',
      'tenant_ai_settings',
      'user_ai_consents',
    ],
  },
  {
    moduleName: 'auth',
    sourceSchema: 'auth',
    referenceDataTables: [],
    tables: [
      'tenant_roles',
      'tenant_role_permissions',
      'user_role_assignments',
    ],
  },
];

/**
 * Reference data tables to copy for each module.
 * Derived from MODULE_SCHEMAS.referenceDataTables to ensure a single source of truth.
 *
 * NOTE: Reference data is copied from the same sourceSchema defined in MODULE_SCHEMAS.
 */
/**
 * Default module names for tenant provisioning.
 * Derived from MODULE_SCHEMAS to prevent drift when new modules are added.
 *
 * Usage:
 *   import { DEFAULT_TENANT_MODULES } from '@aquaculture/backend-common';
 *   await schemaManager.createTenantSchema(tenantId, DEFAULT_TENANT_MODULES);
 */
export const DEFAULT_TENANT_MODULES: string[] = MODULE_SCHEMAS.map(m => m.moduleName);

export const REFERENCE_DATA_TABLES: Record<string, string[]> = Object.fromEntries(
  MODULE_SCHEMAS.map(m => [m.moduleName, m.referenceDataTables || []]),
);

/**
 * Provisioning status to distinguish total failure from partial success
 */
export enum ProvisioningStatus {
  /** All tables created successfully */
  COMPLETE = 'COMPLETE',
  /** Schema exists but some tables failed to create */
  PARTIAL = 'PARTIAL',
  /** Schema creation failed entirely (schema was dropped/cleaned up) */
  FAILED = 'FAILED',
}

/**
 * Schema creation result
 */
export interface SchemaCreationResult {
  success: boolean;
  /** Detailed provisioning status distinguishing partial from total failure */
  status: ProvisioningStatus;
  schemaName: string;
  tablesCreated: string[];
  referenceDataCopied: { table: string; rows: number }[];
  errors: string[];
  duration: number;
  alreadyExists?: boolean;
  /**
   * True when at least one table was created successfully AND at least one error
   * was also recorded. Provides a quick boolean signal for consumers that need to
   * distinguish "some succeeded, some failed" from a clean success or a total
   * failure without inspecting `status === ProvisioningStatus.PARTIAL` directly.
   */
  partialSuccess?: boolean;
}

// SchemaLRUCache is imported from ./schema-lru-cache (shared across all services)
import { SchemaLRUCache } from './schema-lru-cache';

/**
 * SEC-M13: Validate tenant schema name format to prevent SQL injection.
 * Only allows the pattern 'public' or 'tenant_{16 hex chars}' which is the
 * standard tenant schema naming convention used across the platform.
 * This is a defense-in-depth measure — schema names are also validated at the guard level.
 *
 * @param schema - The schema name to validate
 * @returns The validated schema name (unchanged)
 * @throws Error if the schema name does not match the expected format
 */
export function validateTenantSchemaName(schema: string): string {
  if (schema === 'public') return schema;
  const TENANT_SCHEMA_REGEX = /^tenant_[a-f0-9]{16}$/;
  if (!TENANT_SCHEMA_REGEX.test(schema)) {
    throw new Error(`SEC-M13: Invalid schema name format: ${schema}`);
  }
  return schema;
}

/**
 * SECURITY: Validate SQL identifier (schema/table name) to prevent injection
 * Only allows alphanumeric characters and underscores
 * @throws BadRequestException if identifier contains invalid characters
 */
function validateSqlIdentifier(identifier: string, type: 'schema' | 'table'): string {
  const identifierRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  if (!identifierRegex.test(identifier) || identifier.length > 63) {
    throw new BadRequestException(
      `SECURITY: Invalid ${type} identifier: ${identifier}. Only alphanumeric and underscore allowed.`
    );
  }
  return identifier;
}

/**
 * Schema Manager Service
 * Manages tenant-specific PostgreSQL schemas for complete data isolation
 *
 * Features:
 * - Advisory locks for race condition prevention
 * - LRU caching for schema existence checks
 * - SQL injection prevention via UUID validation AND identifier validation
 * - Reference data copying for lookup tables
 * - Atomic schema creation with cleanup on failure
 */
@Injectable()
export class SchemaManagerService {
  private readonly logger = new Logger(SchemaManagerService.name);

  /** LRU cache for schema existence checks (max 1000 entries, positive TTL=5 min, negative TTL=30 s) */
  private readonly schemaCache = new SchemaLRUCache(1000, 5 * 60 * 1000, 30_000);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Generate tenant schema name from tenant ID
   * Format: tenant_{first16chars_of_uuid} (uses 16 chars to avoid collisions)
   *
   * Note: Using 16 hex characters provides 2^64 possible combinations,
   * making collisions practically impossible (birthday problem threshold ~4 billion tenants)
   *
   * @throws BadRequestException if tenant ID is not a valid UUID
   */
  getTenantSchemaName(tenantId: string): string {
    // Validate UUID format (SQL injection prevention)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(tenantId)) {
      throw new BadRequestException(`Invalid tenant ID format: ${tenantId}`);
    }

    // Use tenant_ prefix + first 16 chars of UUID (without dashes)
    // 16 hex chars = 64 bits = collision-safe for billions of tenants
    const cleanId = tenantId.replace(/-/g, '').substring(0, 16).toLowerCase();
    return `tenant_${cleanId}`;
  }

  /**
   * Generate advisory lock key from tenant ID
   * Creates a deterministic 32-bit integer for PostgreSQL advisory locks
   * Used to prevent race conditions when creating schemas
   *
   * SECURITY FIX: Uses SHA-256 instead of MD5 (which is cryptographically weak)
   * Also uses Math.abs() to ensure positive lock keys (PostgreSQL supports negative,
   * but positive values are more predictable for logging/debugging)
   */
  private getAdvisoryLockKey(tenantId: string): number {
    const hash = crypto.createHash('sha256').update(tenantId).digest();
    // Use absolute value to avoid negative lock keys
    // readInt32LE can return negative values due to signed integer representation
    return Math.abs(hash.readInt32LE(0));
  }

  /**
   * Get the application database role for GRANT statements.
   *
   * Resolution order:
   * 1. `DB_APPLICATION_ROLE` environment variable — allows explicit configuration of the
   *    runtime database role when it differs from the provisioning/migration user.
   * 2. `current_user` from the active session — safe fallback that works in most deployments.
   * 3. Literal `CURRENT_USER` SQL keyword — last-resort fallback if the query fails.
   *
   * Set `DB_APPLICATION_ROLE=app_user` in production to ensure the runtime application role
   * always receives schema grants regardless of which user runs the provisioning.
   */
  private async getApplicationRole(): Promise<string> {
    // 1. Check explicit env-var configuration
    const envRole = process.env['DB_APPLICATION_ROLE'];
    if (envRole) {
      // Validate role name to prevent injection
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(envRole)) {
        this.logger.debug(`Using DB_APPLICATION_ROLE for grants: "${envRole}"`);
        return `"${envRole}"`;
      }
      this.logger.warn(
        `DB_APPLICATION_ROLE value "${envRole}" is not a valid SQL identifier. Falling back to current_user.`,
      );
    }

    // 2. Fall back to current session user
    const result = await this.dataSource.query(`SELECT current_user AS role`);
    const role = result[0]?.role;
    if (role) {
      // Validate role name to prevent injection
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(role)) {
        return `"${role}"`;
      }
    }

    // 3. Last resort: SQL CURRENT_USER keyword
    return 'CURRENT_USER';
  }

  /**
   * Validate that schema name is safe for SQL queries
   * Additional safety layer beyond UUID validation
   */
  private isValidSchemaName(schemaName: string): boolean {
    // Match tenant_ prefix + 16 hex characters
    return /^tenant_[a-f0-9]{16}$/.test(schemaName);
  }

  /**
   * Create a new tenant schema with all module tables
   *
   * Uses PostgreSQL advisory locks to prevent race conditions when
   * multiple requests try to create the same tenant schema.
   *
   * Features:
   * - Advisory lock for thread-safety
   * - Idempotent (returns success if schema already exists)
   * - Reference data copying for lookup tables
   * - Atomic with cleanup on failure
   */
  async createTenantSchema(
    tenantId: string,
    modules: string[] = DEFAULT_TENANT_MODULES,
  ): Promise<SchemaCreationResult> {
    const startTime = Date.now();
    const schemaName = this.getTenantSchemaName(tenantId);
    const lockKey = this.getAdvisoryLockKey(tenantId);
    const tablesCreated: string[] = [];
    const referenceDataCopied: { table: string; rows: number }[] = [];
    const errors: string[] = [];

    // Validate schema name as additional safety
    if (!this.isValidSchemaName(schemaName)) {
      return {
        success: false,
        status: ProvisioningStatus.FAILED,
        schemaName,
        tablesCreated: [],
        referenceDataCopied: [],
        errors: [`Invalid schema name generated: ${schemaName}`],
        duration: Date.now() - startTime,
      };
    }

    this.logger.log(`Acquiring advisory lock for tenant ${tenantId} (key: ${lockKey})`);

    // Acquire advisory lock - blocks if another process is creating same schema
    await this.dataSource.query(`SELECT pg_advisory_lock($1)`, [lockKey]);

    try {
      // Check if schema already exists (idempotent operation)
      const exists = await this.schemaExistsNoCache(schemaName);
      if (exists) {
        this.logger.log(`Schema ${schemaName} already exists, skipping creation`);
        this.schemaCache.set(schemaName, true);
        return {
          success: true,
          status: ProvisioningStatus.COMPLETE,
          schemaName,
          tablesCreated: [],
          referenceDataCopied: [],
          errors: [],
          duration: Date.now() - startTime,
          alreadyExists: true,
        };
      }

      this.logger.log(`Creating tenant schema: ${schemaName} for tenant ${tenantId}`);

      // 1. Create the schema (with SQL injection protection)
      const safeSchemaName = validateSqlIdentifier(schemaName, 'schema');
      await this.dataSource.query(`CREATE SCHEMA "${safeSchemaName}"`);
      this.logger.debug(`Schema ${safeSchemaName} created`);

      // 2. Create tables for requested modules (uses the modules parameter)
      for (const moduleName of modules) {
        const moduleSchema = MODULE_SCHEMAS.find(m => m.moduleName === moduleName);
        if (!moduleSchema) {
          this.logger.warn(`Module ${moduleName} not found in schema definitions`);
          continue;
        }

        for (const tableName of moduleSchema.tables) {
          try {
            // Check if source table exists
            const sourceTableExists = await this.tableExists(
              moduleSchema.sourceSchema,
              tableName,
            );

            if (sourceTableExists) {
              // Create table structure from source (including indexes and constraints)
              // SECURITY: Validate all identifiers before using in SQL
              const safeTargetSchema = validateSqlIdentifier(schemaName, 'schema');
              const safeTableName = validateSqlIdentifier(tableName, 'table');
              const safeSourceSchema = validateSqlIdentifier(moduleSchema.sourceSchema, 'schema');

              await this.dataSource.query(`
                CREATE TABLE "${safeTargetSchema}"."${safeTableName}"
                (LIKE "${safeSourceSchema}"."${safeTableName}" INCLUDING ALL)
              `);
              tablesCreated.push(`${safeTargetSchema}.${safeTableName}`);
              this.logger.debug(`Table ${schemaName}.${tableName} created`);

              // Convert time-series tables to TimescaleDB hypertable
              if (tableName === 'sensor_readings') {
                await this.createHypertable(schemaName, tableName);
              }

              // Convert sensor_metrics to hypertable with new narrow table format
              if (tableName === 'sensor_metrics') {
                await this.createSensorMetricsHypertable(schemaName);
              }
            } else {
              this.logger.warn(
                `Source table ${moduleSchema.sourceSchema}.${tableName} does not exist`,
              );
            }
          } catch (tableError) {
            const errorMsg = `Failed to create table ${tableName}: ${(tableError as Error).message}`;
            errors.push(errorMsg);
            this.logger.error(errorMsg);
          }
        }
      }

      // 3. Copy reference data for requested modules
      for (const moduleName of modules) {
        const refTables = REFERENCE_DATA_TABLES[moduleName];
        if (!refTables) continue;

        const moduleSchema = MODULE_SCHEMAS.find(m => m.moduleName === moduleName);
        if (!moduleSchema) continue;

        for (const tableName of refTables) {
          try {
            const rows = await this.copyReferenceDataTable(
              schemaName,
              moduleSchema.sourceSchema,
              tableName,
            );
            if (rows > 0) {
              referenceDataCopied.push({ table: tableName, rows });
            }
          } catch (copyError) {
            const errorMsg = `Failed to copy reference data ${tableName}: ${(copyError as Error).message}`;
            errors.push(errorMsg);
            this.logger.warn(errorMsg);
          }
        }
      }

      // 4. Grant permissions to the application role (or current user as fallback)
      // Using parameterized role name to ensure the runtime user has access
      // even when the migration user differs from the application user
      const appRole = await this.getApplicationRole();
      await this.dataSource.query(`
        GRANT USAGE ON SCHEMA "${schemaName}" TO ${appRole}
      `);

      await this.dataSource.query(`
        GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA "${schemaName}" TO ${appRole}
      `);

      await this.dataSource.query(`
        GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "${schemaName}" TO ${appRole}
      `);

      // Update cache
      this.schemaCache.set(schemaName, true);

      const totalRefRows = referenceDataCopied.reduce((sum, r) => sum + r.rows, 0);
      this.logger.log(
        `Tenant schema ${schemaName} created: ${tablesCreated.length} tables, ${totalRefRows} reference rows in ${Date.now() - startTime}ms`,
      );

      const hasErrors = errors.length > 0;
      const isPartial = hasErrors && tablesCreated.length > 0;
      return {
        success: !hasErrors,
        status: hasErrors ? ProvisioningStatus.PARTIAL : ProvisioningStatus.COMPLETE,
        schemaName,
        tablesCreated,
        referenceDataCopied,
        errors,
        duration: Date.now() - startTime,
        partialSuccess: isPartial || undefined,
      };
    } catch (error) {
      const errorMsg = `Failed to create tenant schema: ${(error as Error).message}`;
      this.logger.error(errorMsg, (error as Error).stack);
      errors.push(errorMsg);

      // CLEANUP: Drop partial schema on failure
      this.logger.warn(`Cleaning up partial schema ${schemaName} after failure`);
      try {
        await this.dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
        this.logger.log(`Cleaned up partial schema ${schemaName}`);
      } catch (cleanupError) {
        this.logger.error(`Cleanup failed for ${schemaName}: ${(cleanupError as Error).message}`);
      }

      return {
        success: false,
        status: ProvisioningStatus.FAILED,
        schemaName,
        tablesCreated,
        referenceDataCopied,
        errors,
        duration: Date.now() - startTime,
      };
    } finally {
      // ALWAYS release advisory lock
      await this.dataSource.query(`SELECT pg_advisory_unlock($1)`, [lockKey]);
      this.logger.debug(`Released advisory lock for tenant ${tenantId}`);
    }
  }

  /**
   * Copy reference data from source schema to tenant schema
   * Used for lookup/configuration tables like equipment_types
   *
   * SECURITY: All schema and table names are validated before use in SQL
   * to prevent SQL injection attacks.
   */
  private async copyReferenceDataTable(
    targetSchema: string,
    sourceSchema: string,
    tableName: string,
  ): Promise<number> {
    // SECURITY: Validate all identifiers before using in SQL queries
    const safeTargetSchema = validateSqlIdentifier(targetSchema, 'schema');
    const safeSourceSchema = validateSqlIdentifier(sourceSchema, 'schema');
    const safeTableName = validateSqlIdentifier(tableName, 'table');

    // Check if target table exists
    const targetExists = await this.tableExists(safeTargetSchema, safeTableName);
    if (!targetExists) {
      this.logger.debug(`Target table ${safeTargetSchema}.${safeTableName} does not exist, skipping copy`);
      return 0;
    }

    // Check if source table exists and has data
    const sourceExists = await this.tableExists(safeSourceSchema, safeTableName);
    if (!sourceExists) {
      this.logger.debug(`Source table ${safeSourceSchema}.${safeTableName} does not exist, skipping copy`);
      return 0;
    }

    // Check if target already has data (avoid duplicate copies)
    const existingCount = await this.dataSource.query(
      `SELECT COUNT(*) as count FROM "${safeTargetSchema}"."${safeTableName}"`,
    );
    if (parseInt(existingCount[0]?.count || '0', 10) > 0) {
      this.logger.debug(`Target table ${safeTargetSchema}.${safeTableName} already has data, skipping copy`);
      return 0;
    }

    // Get source row count first
    const sourceCountResult = await this.dataSource.query(
      `SELECT COUNT(*) as count FROM "${safeSourceSchema}"."${safeTableName}"`,
    );
    const sourceCount = parseInt(sourceCountResult[0]?.count || '0', 10);

    if (sourceCount === 0) {
      this.logger.debug(`Source table ${safeSourceSchema}.${safeTableName} is empty, skipping copy`);
      return 0;
    }

    // Copy data from source to target
    await this.dataSource.query(`
      INSERT INTO "${safeTargetSchema}"."${safeTableName}"
      SELECT * FROM "${safeSourceSchema}"."${safeTableName}"
    `);

    // Verify rows were copied by counting target
    const targetCountResult = await this.dataSource.query(
      `SELECT COUNT(*) as count FROM "${safeTargetSchema}"."${safeTableName}"`,
    );
    const rowsCopied = parseInt(targetCountResult[0]?.count || '0', 10);

    this.logger.debug(`Copied ${rowsCopied} rows to ${safeTargetSchema}.${safeTableName}`);
    return rowsCopied;
  }

  /**
   * Delete a tenant schema and all its data
   * Uses advisory lock to prevent race conditions with concurrent operations
   */
  async deleteTenantSchema(tenantId: string): Promise<{ success: boolean; error?: string }> {
    const schemaName = this.getTenantSchemaName(tenantId);
    const lockKey = this.getAdvisoryLockKey(tenantId);

    this.logger.log(`Acquiring advisory lock for tenant deletion ${tenantId} (key: ${lockKey})`);

    // Acquire advisory lock - blocks if another process is operating on same schema
    await this.dataSource.query(`SELECT pg_advisory_lock($1)`, [lockKey]);

    try {
      this.logger.log(`Deleting tenant schema: ${schemaName}`);

      // CASCADE drops all objects in the schema
      await this.dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);

      // Invalidate cache entry for deleted schema
      this.schemaCache.invalidate(schemaName);

      this.logger.log(`Tenant schema ${schemaName} deleted successfully`);
      return { success: true };
    } catch (error) {
      const errorMsg = `Failed to delete tenant schema: ${(error as Error).message}`;
      this.logger.error(errorMsg);
      return { success: false, error: errorMsg };
    } finally {
      // ALWAYS release advisory lock
      await this.dataSource.query(`SELECT pg_advisory_unlock($1)`, [lockKey]);
      this.logger.debug(`Released advisory lock for tenant deletion ${tenantId}`);
    }
  }

  /**
   * Check if a schema exists (with LRU caching)
   * Use this for frequent checks to reduce database load
   */
  async schemaExists(schemaName: string): Promise<boolean> {
    // Check cache first
    const cached = this.schemaCache.get(schemaName);
    if (cached !== undefined) {
      return cached;
    }

    // Query database
    const exists = await this.schemaExistsNoCache(schemaName);
    this.schemaCache.set(schemaName, exists);
    return exists;
  }

  /**
   * Check if a schema exists (bypasses cache)
   * Use this when you need guaranteed fresh result
   */
  async schemaExistsNoCache(schemaName: string): Promise<boolean> {
    const result = await this.dataSource.query(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`,
      [schemaName],
    );
    return result.length > 0;
  }

  /**
   * Check if tenant schema exists (convenience method)
   */
  async tenantSchemaExists(tenantId: string): Promise<boolean> {
    const schemaName = this.getTenantSchemaName(tenantId);
    return this.schemaExists(schemaName);
  }

  /**
   * Invalidate schema cache entry
   * Call this after schema deletion
   */
  invalidateSchemaCache(schemaName: string): void {
    this.schemaCache.invalidate(schemaName);
  }

  /**
   * Clear entire schema cache
   * Use sparingly, typically only for testing
   */
  clearSchemaCache(): void {
    this.schemaCache.clear();
  }

  /**
   * Check if a table exists in a schema
   */
  async tableExists(schemaName: string, tableName: string): Promise<boolean> {
    const result = await this.dataSource.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2`,
      [schemaName, tableName],
    );
    return result.length > 0;
  }

  /**
   * Convert a table to TimescaleDB hypertable
   * Used for time-series tables like sensor_readings
   */
  private async createHypertable(schemaName: string, tableName: string): Promise<void> {
    try {
      // Check if TimescaleDB extension is available
      const extensionCheck = await this.dataSource.query(
        `SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'`,
      );

      if (extensionCheck.length === 0) {
        this.logger.warn('TimescaleDB extension not installed, skipping hypertable creation');
        return;
      }

      // Check if table is already a hypertable
      const isHypertable = await this.dataSource.query(
        `SELECT 1 FROM timescaledb_information.hypertables
         WHERE hypertable_schema = $1 AND hypertable_name = $2`,
        [schemaName, tableName],
      );

      if (isHypertable.length > 0) {
        this.logger.debug(`${schemaName}.${tableName} is already a hypertable`);
        return;
      }

      // Convert to hypertable with timestamp column partitioning
      await this.dataSource.query(`
        SELECT create_hypertable(
          '"${schemaName}"."${tableName}"',
          'timestamp',
          if_not_exists => TRUE,
          migrate_data => TRUE
        )
      `);

      this.logger.log(`Created hypertable: ${schemaName}.${tableName}`);

      // Add TimescaleDB data management policies
      await this.addRetentionPolicy(schemaName, tableName);
      await this.addCompressionPolicy(schemaName, tableName);
      await this.createContinuousAggregates(schemaName);
    } catch (error) {
      // Log but don't fail - hypertable is an optimization, not a requirement
      this.logger.warn(
        `Failed to create hypertable ${schemaName}.${tableName}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Add retention policy - automatically drop data older than 90 days
   * This prevents the table from growing indefinitely
   */
  private async addRetentionPolicy(schemaName: string, tableName: string): Promise<void> {
    try {
      // Check if policy already exists
      const existingPolicy = await this.dataSource.query(`
        SELECT 1 FROM timescaledb_information.jobs
        WHERE proc_schema = '_timescaledb_functions'
          AND proc_name = 'policy_retention_check'
          AND hypertable_schema = $1
          AND hypertable_name = $2
      `, [schemaName, tableName]);

      if (existingPolicy.length > 0) {
        this.logger.debug(`Retention policy already exists for ${schemaName}.${tableName}`);
        return;
      }

      await this.dataSource.query(`
        SELECT add_retention_policy(
          '"${schemaName}"."${tableName}"',
          INTERVAL '90 days',
          if_not_exists => TRUE
        )
      `);

      this.logger.log(`Added 90-day retention policy for ${schemaName}.${tableName}`);
    } catch (error) {
      this.logger.warn(
        `Failed to add retention policy for ${schemaName}.${tableName}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Add compression policy - compress data older than 7 days
   * Reduces storage by ~90% for historical data
   */
  private async addCompressionPolicy(schemaName: string, tableName: string): Promise<void> {
    try {
      // First enable compression on the hypertable
      // Note: tenant_id excluded from segmentby because in tenant-isolated schema
      // all rows have same tenant_id (would waste space)
      await this.dataSource.query(`
        ALTER TABLE "${schemaName}"."${tableName}" SET (
          timescaledb.compress,
          timescaledb.compress_segmentby = 'sensor_id',
          timescaledb.compress_orderby = 'timestamp DESC'
        )
      `);

      // Add compression policy
      await this.dataSource.query(`
        SELECT add_compression_policy(
          '"${schemaName}"."${tableName}"',
          INTERVAL '7 days',
          if_not_exists => TRUE
        )
      `);

      this.logger.log(`Added 7-day compression policy for ${schemaName}.${tableName}`);
    } catch (error) {
      this.logger.warn(
        `Failed to add compression policy for ${schemaName}.${tableName}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Create continuous aggregates for efficient charting.
   * Pre-aggregates data at hourly and daily intervals.
   *
   * JSONB KEY CONVENTION: The `sensor_readings.readings` column stores sensor data as a
   * JSONB object with camelCase keys as produced by the sensor-service TypeORM entity
   * (e.g., "dissolvedOxygen", "ph", "temperature", "salinity"). These key names must
   * exactly match what sensor-service writes. If sensor-service ever changes these key
   * names, update the aggregate expressions below and rebuild the continuous aggregates
   * (DROP the view and re-run this method).
   */
  private async createContinuousAggregates(schemaName: string): Promise<void> {
    try {
      // Check if hourly aggregate already exists
      const hourlyExists = await this.dataSource.query(`
        SELECT 1 FROM timescaledb_information.continuous_aggregates
        WHERE view_schema = $1 AND view_name = 'sensor_hourly'
      `, [schemaName]);

      if (hourlyExists.length === 0) {
        // Create hourly aggregate
        // JSONB keys: camelCase ('temperature', 'ph', 'dissolvedOxygen', 'salinity')
        await this.dataSource.query(`
          CREATE MATERIALIZED VIEW "${schemaName}"."sensor_hourly"
          WITH (timescaledb.continuous) AS
          SELECT
            time_bucket('1 hour', timestamp) AS bucket,
            sensor_id,
            tenant_id,
            AVG((readings->>'temperature')::numeric) as avg_temperature,
            AVG((readings->>'ph')::numeric) as avg_ph,
            AVG((readings->>'dissolvedOxygen')::numeric) as avg_dissolved_oxygen,
            AVG((readings->>'salinity')::numeric) as avg_salinity,
            MIN((readings->>'temperature')::numeric) as min_temperature,
            MAX((readings->>'temperature')::numeric) as max_temperature,
            COUNT(*) as reading_count
          FROM "${schemaName}"."sensor_readings"
          GROUP BY bucket, sensor_id, tenant_id
          WITH NO DATA
        `);

        // Add refresh policy for hourly aggregate
        await this.dataSource.query(`
          SELECT add_continuous_aggregate_policy(
            '"${schemaName}"."sensor_hourly"',
            start_offset => INTERVAL '3 hours',
            end_offset => INTERVAL '1 hour',
            schedule_interval => INTERVAL '1 hour',
            if_not_exists => TRUE
          )
        `);

        this.logger.log(`Created hourly continuous aggregate for ${schemaName}`);
      }

      // Check if daily aggregate already exists
      const dailyExists = await this.dataSource.query(`
        SELECT 1 FROM timescaledb_information.continuous_aggregates
        WHERE view_schema = $1 AND view_name = 'sensor_daily'
      `, [schemaName]);

      if (dailyExists.length === 0) {
        // Create daily aggregate
        await this.dataSource.query(`
          CREATE MATERIALIZED VIEW "${schemaName}"."sensor_daily"
          WITH (timescaledb.continuous) AS
          SELECT
            time_bucket('1 day', timestamp) AS bucket,
            sensor_id,
            tenant_id,
            AVG((readings->>'temperature')::numeric) as avg_temperature,
            AVG((readings->>'ph')::numeric) as avg_ph,
            AVG((readings->>'dissolvedOxygen')::numeric) as avg_dissolved_oxygen,
            AVG((readings->>'salinity')::numeric) as avg_salinity,
            MIN((readings->>'temperature')::numeric) as min_temperature,
            MAX((readings->>'temperature')::numeric) as max_temperature,
            COUNT(*) as reading_count
          FROM "${schemaName}"."sensor_readings"
          GROUP BY bucket, sensor_id, tenant_id
          WITH NO DATA
        `);

        // Add refresh policy for daily aggregate
        await this.dataSource.query(`
          SELECT add_continuous_aggregate_policy(
            '"${schemaName}"."sensor_daily"',
            start_offset => INTERVAL '3 days',
            end_offset => INTERVAL '1 day',
            schedule_interval => INTERVAL '1 day',
            if_not_exists => TRUE
          )
        `);

        this.logger.log(`Created daily continuous aggregate for ${schemaName}`);
      }
    } catch (error) {
      this.logger.warn(
        `Failed to create continuous aggregates for ${schemaName}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Migrate existing data from shared schema to tenant schema
   *
   * SECURITY: All schema and table names are validated before use in SQL
   * to prevent SQL injection attacks.
   */
  async migrateDataToTenantSchema(
    tenantId: string,
    sourceSchema: string,
    tableName: string,
  ): Promise<{ rowsMigrated: number; error?: string }> {
    const schemaName = this.getTenantSchemaName(tenantId);

    // SECURITY: Validate all identifiers before using in SQL queries
    const safeSchemaName = validateSqlIdentifier(schemaName, 'schema');
    const safeSourceSchema = validateSqlIdentifier(sourceSchema, 'schema');
    const safeTableName = validateSqlIdentifier(tableName, 'table');

    try {
      this.logger.log(
        `Migrating data from ${safeSourceSchema}.${safeTableName} to ${safeSchemaName}.${safeTableName}`,
      );

      // Count rows before migration
      const beforeCountResult = await this.dataSource.query(
        `SELECT COUNT(*) as count FROM "${safeSchemaName}"."${safeTableName}"`,
      );
      const beforeCount = parseInt(beforeCountResult[0]?.count || '0', 10);

      // Insert data with tenant filter
      // Note: tenant column name varies by table (tenant_id for sensor/new tables, tenantId for legacy farm/hr)
      // Try tenant_id first (snake_case), fall back to "tenantId" (camelCase)
      try {
        await this.dataSource.query(`
          INSERT INTO "${safeSchemaName}"."${safeTableName}"
          SELECT * FROM "${safeSourceSchema}"."${safeTableName}"
          WHERE tenant_id = $1
          ON CONFLICT DO NOTHING
        `, [tenantId]);
      } catch {
        await this.dataSource.query(`
          INSERT INTO "${safeSchemaName}"."${safeTableName}"
          SELECT * FROM "${safeSourceSchema}"."${safeTableName}"
          WHERE "tenantId" = $1
          ON CONFLICT DO NOTHING
        `, [tenantId]);
      }

      // Count rows after migration to get actual migrated count
      const afterCountResult = await this.dataSource.query(
        `SELECT COUNT(*) as count FROM "${safeSchemaName}"."${safeTableName}"`,
      );
      const afterCount = parseInt(afterCountResult[0]?.count || '0', 10);
      const rowsMigrated = afterCount - beforeCount;

      this.logger.log(`Migrated ${rowsMigrated} rows to ${safeSchemaName}.${safeTableName}`);

      return { rowsMigrated };
    } catch (error) {
      const errorMsg = `Migration failed: ${(error as Error).message}`;
      this.logger.error(errorMsg);
      return { rowsMigrated: 0, error: errorMsg };
    }
  }

  /**
   * Get all tenant schemas
   */
  async listTenantSchemas(): Promise<string[]> {
    const result = await this.dataSource.query(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name LIKE 'tenant_%'
      ORDER BY schema_name
    `);
    return result.map((r: { schema_name: string }) => r.schema_name);
  }

  /**
   * Get table count for a schema
   */
  async getSchemaTableCount(schemaName: string): Promise<number> {
    const result = await this.dataSource.query(
      `SELECT COUNT(*) as count
       FROM information_schema.tables
       WHERE table_schema = $1`,
      [schemaName],
    );
    return parseInt(result[0]?.count || '0', 10);
  }

  /**
   * Validate that MODULE_SCHEMAS is consistent with the actual source schemas in the database.
   *
   * Intended for use in integration tests to detect drift between the MODULE_SCHEMAS
   * constant and the actual entity/migration definitions. Checks that every table listed
   * in MODULE_SCHEMAS exists in the corresponding source schema.
   *
   * @returns An object describing which registered tables were found and which were missing.
   *
   * @example
   * // In an integration test:
   * const result = await schemaManager.validateModuleSchemas();
   * expect(result.missing).toHaveLength(0);
   */
  async validateModuleSchemas(): Promise<{
    valid: boolean;
    missing: Array<{ module: string; table: string; sourceSchema: string }>;
    found: Array<{ module: string; table: string; sourceSchema: string }>;
  }> {
    const missing: Array<{ module: string; table: string; sourceSchema: string }> = [];
    const found: Array<{ module: string; table: string; sourceSchema: string }> = [];

    for (const moduleSchema of MODULE_SCHEMAS) {
      for (const tableName of moduleSchema.tables) {
        const exists = await this.tableExists(moduleSchema.sourceSchema, tableName);
        const entry = {
          module: moduleSchema.moduleName,
          table: tableName,
          sourceSchema: moduleSchema.sourceSchema,
        };
        if (exists) {
          found.push(entry);
        } else {
          missing.push(entry);
          this.logger.warn(
            `MODULE_SCHEMAS validation: table "${moduleSchema.sourceSchema}"."${tableName}" ` +
            `registered for module "${moduleSchema.moduleName}" does not exist in the database.`,
          );
        }
      }
    }

    return {
      valid: missing.length === 0,
      missing,
      found,
    };
  }

  /**
   * Set search_path for tenant context
   *
   * WARNING: This method sets search_path at connection level.
   * In a connection pool, the next query might use a different connection.
   * For reliable tenant isolation, use one of these approaches:
   *
   * 1. Use setTenantSearchPathInTransaction() within a transaction
   * 2. Use explicit schema prefixes in queries: SELECT * FROM "tenant_xxx"."table"
   * 3. Use a request-scoped connection (not recommended for performance)
   *
   * This method is safe to use only when:
   * - You're within a transaction that holds the connection
   * - You immediately execute queries after this call
   *
   * SECURITY: Schema name is validated via getTenantSchemaName() which:
   * - Validates UUID format
   * - Generates safe schema name (tenant_ + 16 hex chars only)
   * Additional validation via isValidSchemaName() prevents SQL injection
   */
  async setTenantSearchPath(tenantId: string): Promise<void> {
    const schemaName = this.getTenantSchemaName(tenantId);

    // SECURITY: Double-check schema name format to prevent SQL injection
    if (!this.isValidSchemaName(schemaName)) {
      throw new BadRequestException(`SECURITY: Invalid schema name format: ${schemaName}`);
    }

    // SECURITY: Use parameterized query with pg_catalog.set_config for safe schema setting
    // This is safer than string interpolation in SET command
    await this.dataSource.query(
      `SELECT pg_catalog.set_config('search_path', $1 || ', public', false)`,
      [schemaName],
    );
  }

  /**
   * Set search_path within a transaction (connection-safe)
   * Use this for reliable tenant isolation in connection pools
   *
   * SECURITY: Uses SET LOCAL which is transaction-scoped and safe.
   * Schema name is validated to prevent SQL injection.
   *
   * @example
   * await dataSource.transaction(async (manager) => {
   *   await schemaManager.setTenantSearchPathInTransaction(manager, tenantId);
   *   // All queries in this transaction will use tenant schema
   *   await manager.query('SELECT * FROM sensors');
   * });
   */
  async setTenantSearchPathInTransaction(
    manager: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    tenantId: string,
  ): Promise<void> {
    const schemaName = this.getTenantSchemaName(tenantId);

    // SECURITY: Double-check schema name format to prevent SQL injection
    if (!this.isValidSchemaName(schemaName)) {
      throw new BadRequestException(`SECURITY: Invalid schema name format: ${schemaName}`);
    }

    // SECURITY: Use parameterized query with pg_catalog.set_config for safe schema setting
    // The 'true' parameter makes it LOCAL (transaction-scoped)
    await manager.query(
      `SELECT pg_catalog.set_config('search_path', $1 || ', public', true)`,
      [schemaName],
    );
  }

  /**
   * Reset search_path to default
   *
   * WARNING: Same connection pool limitations as setTenantSearchPath()
   */
  async resetSearchPath(): Promise<void> {
    // SECURITY: No user input involved, safe to use directly
    await this.dataSource.query(
      `SELECT pg_catalog.set_config('search_path', 'public', false)`,
    );
  }

  /**
   * Create sensor_metrics hypertable with narrow table optimizations
   * Includes compression, retention, and continuous aggregates
   */
  private async createSensorMetricsHypertable(schemaName: string): Promise<void> {
    const tableName = 'sensor_metrics';

    try {
      // Check if TimescaleDB extension is available
      const extensionCheck = await this.dataSource.query(
        `SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'`,
      );

      if (extensionCheck.length === 0) {
        this.logger.warn('TimescaleDB extension not installed, skipping sensor_metrics hypertable');
        return;
      }

      // Check if table is already a hypertable
      const isHypertable = await this.dataSource.query(
        `SELECT 1 FROM timescaledb_information.hypertables
         WHERE hypertable_schema = $1 AND hypertable_name = $2`,
        [schemaName, tableName],
      );

      if (isHypertable.length > 0) {
        this.logger.debug(`${schemaName}.${tableName} is already a hypertable`);
        return;
      }

      // Convert to hypertable with 'time' column partitioning
      await this.dataSource.query(`
        SELECT create_hypertable(
          '"${schemaName}"."${tableName}"',
          'time',
          chunk_time_interval => INTERVAL '1 day',
          if_not_exists => TRUE,
          migrate_data => TRUE
        )
      `);

      this.logger.log(`Created hypertable: ${schemaName}.${tableName}`);

      // Enable compression
      // Note: tenant_id excluded from segmentby because in tenant-isolated schema
      // all rows have same tenant_id (would waste space)
      await this.dataSource.query(`
        ALTER TABLE "${schemaName}"."${tableName}" SET (
          timescaledb.compress,
          timescaledb.compress_segmentby = 'sensor_id, channel_id',
          timescaledb.compress_orderby = 'time DESC'
        )
      `);

      // Add compression policy (7 days)
      await this.dataSource.query(`
        SELECT add_compression_policy(
          '"${schemaName}"."${tableName}"',
          INTERVAL '7 days',
          if_not_exists => TRUE
        )
      `);

      this.logger.log(`Added compression policy for ${schemaName}.${tableName}`);

      // Add retention policy (90 days for raw data)
      await this.dataSource.query(`
        SELECT add_retention_policy(
          '"${schemaName}"."${tableName}"',
          INTERVAL '90 days',
          if_not_exists => TRUE
        )
      `);

      this.logger.log(`Added retention policy for ${schemaName}.${tableName}`);

      // Create continuous aggregates for the narrow table
      await this.createNarrowTableAggregates(schemaName);

    } catch (error) {
      this.logger.warn(
        `Failed to create sensor_metrics hypertable for ${schemaName}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Sync existing tenant schema — add any missing tables from MODULE_SCHEMAS.
   *
   * Unlike createTenantSchema (which starts from scratch), this method:
   * 1. Iterates MODULE_SCHEMAS for requested modules
   * 2. Checks each table with tableExists()
   * 3. Creates only the missing ones via CREATE TABLE ... LIKE ... INCLUDING ALL
   * 4. Copies missing reference data
   *
   * Safe to call repeatedly (idempotent).
   */
  async syncTenantSchema(
    tenantId: string,
    modules: string[] = DEFAULT_TENANT_MODULES,
  ): Promise<{ created: string[]; skipped: string[]; errors: string[] }> {
    const schemaName = this.getTenantSchemaName(tenantId);
    const created: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    // Check schema exists
    const exists = await this.schemaExistsNoCache(schemaName);
    if (!exists) {
      errors.push(`Schema ${schemaName} does not exist`);
      return { created, skipped, errors };
    }

    this.logger.log(`Syncing tenant schema ${schemaName} for modules: ${modules.join(', ')}`);

    for (const moduleName of modules) {
      const moduleSchema = MODULE_SCHEMAS.find(m => m.moduleName === moduleName);
      if (!moduleSchema) {
        this.logger.warn(`Module ${moduleName} not found in MODULE_SCHEMAS`);
        continue;
      }

      for (const tableName of moduleSchema.tables) {
        try {
          // Check if table already exists in tenant schema
          const alreadyExists = await this.tableExists(schemaName, tableName);
          if (alreadyExists) {
            skipped.push(tableName);
            continue;
          }

          // Check if source table exists
          const sourceExists = await this.tableExists(moduleSchema.sourceSchema, tableName);
          if (!sourceExists) {
            errors.push(`Source table ${moduleSchema.sourceSchema}.${tableName} does not exist`);
            continue;
          }

          // Create table from source
          const safeTargetSchema = validateSqlIdentifier(schemaName, 'schema');
          const safeTableName = validateSqlIdentifier(tableName, 'table');
          const safeSourceSchema = validateSqlIdentifier(moduleSchema.sourceSchema, 'schema');

          await this.dataSource.query(`
            CREATE TABLE "${safeTargetSchema}"."${safeTableName}"
            (LIKE "${safeSourceSchema}"."${safeTableName}" INCLUDING ALL)
          `);

          created.push(tableName);
          this.logger.debug(`Created missing table ${schemaName}.${tableName}`);

          // Handle hypertables
          if (tableName === 'sensor_readings') {
            await this.createHypertable(schemaName, tableName);
          }
          if (tableName === 'sensor_metrics') {
            await this.createSensorMetricsHypertable(schemaName);
          }
        } catch (tableError) {
          const msg = `Failed to create ${tableName}: ${(tableError as Error).message}`;
          errors.push(msg);
          this.logger.error(msg);
        }
      }

      // Copy missing reference data
      const refTables = moduleSchema.referenceDataTables || [];
      for (const refTable of refTables) {
        try {
          const rows = await this.copyReferenceDataTable(
            schemaName,
            moduleSchema.sourceSchema,
            refTable,
          );
          if (rows > 0) {
            this.logger.debug(`Copied ${rows} reference rows to ${schemaName}.${refTable}`);
          }
        } catch (copyError) {
          errors.push(`Failed to copy ref data ${refTable}: ${(copyError as Error).message}`);
        }
      }
    }

    // Grant permissions on any newly created tables
    if (created.length > 0) {
      try {
        const appRole = await this.getApplicationRole();
        await this.dataSource.query(
          `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA "${schemaName}" TO ${appRole}`,
        );
        await this.dataSource.query(
          `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "${schemaName}" TO ${appRole}`,
        );
      } catch (grantError) {
        errors.push(`Failed to grant permissions: ${(grantError as Error).message}`);
      }
    }

    this.logger.log(
      `Sync ${schemaName}: ${created.length} created, ${skipped.length} skipped, ${errors.length} errors`,
    );

    return { created, skipped, errors };
  }

  /**
   * Create continuous aggregates for narrow table format (sensor_metrics)
   * Creates 1-minute, 1-hour, and 1-day aggregates
   */
  private async createNarrowTableAggregates(schemaName: string): Promise<void> {
    try {
      // 1. Create 1-minute aggregate
      const min1Exists = await this.dataSource.query(`
        SELECT 1 FROM timescaledb_information.continuous_aggregates
        WHERE view_schema = $1 AND view_name = 'metrics_1min'
      `, [schemaName]);

      if (min1Exists.length === 0) {
        await this.dataSource.query(`
          CREATE MATERIALIZED VIEW "${schemaName}"."metrics_1min"
          WITH (timescaledb.continuous) AS
          SELECT
            time_bucket('1 minute', time) AS bucket,
            tenant_id,
            sensor_id,
            channel_id,
            tank_id,
            AVG(value) AS avg_value,
            MIN(value) AS min_value,
            MAX(value) AS max_value,
            STDDEV(value) AS stddev_value,
            FIRST(value, time) AS first_value,
            LAST(value, time) AS last_value,
            COUNT(*) AS sample_count,
            COUNT(*) FILTER (WHERE quality_code >= 192) AS good_count,
            COUNT(*) FILTER (WHERE quality_code < 192) AS bad_count,
            AVG(ingestion_latency_ms) AS avg_latency_ms,
            MAX(ingestion_latency_ms) AS max_latency_ms
          FROM "${schemaName}"."sensor_metrics"
          GROUP BY bucket, tenant_id, sensor_id, channel_id, tank_id
          WITH NO DATA
        `);

        await this.dataSource.query(`
          SELECT add_continuous_aggregate_policy(
            '"${schemaName}"."metrics_1min"',
            start_offset => INTERVAL '3 minutes',
            end_offset => INTERVAL '1 minute',
            schedule_interval => INTERVAL '1 minute',
            if_not_exists => TRUE
          )
        `);

        await this.dataSource.query(`
          SELECT add_retention_policy(
            '"${schemaName}"."metrics_1min"',
            INTERVAL '1 year',
            if_not_exists => TRUE
          )
        `);

        this.logger.log(`Created metrics_1min aggregate for ${schemaName}`);
      }

      // 2. Create 1-hour aggregate
      const hour1Exists = await this.dataSource.query(`
        SELECT 1 FROM timescaledb_information.continuous_aggregates
        WHERE view_schema = $1 AND view_name = 'metrics_1hour'
      `, [schemaName]);

      if (hour1Exists.length === 0) {
        await this.dataSource.query(`
          CREATE MATERIALIZED VIEW "${schemaName}"."metrics_1hour"
          WITH (timescaledb.continuous) AS
          SELECT
            time_bucket('1 hour', bucket) AS bucket,
            tenant_id,
            sensor_id,
            channel_id,
            tank_id,
            AVG(avg_value) AS avg_value,
            MIN(min_value) AS min_value,
            MAX(max_value) AS max_value,
            SQRT(AVG(POWER(COALESCE(stddev_value, 0), 2))) AS stddev_value,
            FIRST(first_value, bucket) AS first_value,
            LAST(last_value, bucket) AS last_value,
            SUM(sample_count) AS sample_count,
            SUM(good_count) AS good_count,
            SUM(bad_count) AS bad_count,
            (SUM(good_count)::FLOAT / NULLIF(SUM(sample_count), 0) * 100) AS quality_pct
          FROM "${schemaName}"."metrics_1min"
          GROUP BY time_bucket('1 hour', bucket), tenant_id, sensor_id, channel_id, tank_id
          WITH NO DATA
        `);

        await this.dataSource.query(`
          SELECT add_continuous_aggregate_policy(
            '"${schemaName}"."metrics_1hour"',
            start_offset => INTERVAL '3 hours',
            end_offset => INTERVAL '1 hour',
            schedule_interval => INTERVAL '1 hour',
            if_not_exists => TRUE
          )
        `);

        await this.dataSource.query(`
          SELECT add_retention_policy(
            '"${schemaName}"."metrics_1hour"',
            INTERVAL '5 years',
            if_not_exists => TRUE
          )
        `);

        this.logger.log(`Created metrics_1hour aggregate for ${schemaName}`);
      }

      // 3. Create 1-day aggregate
      const day1Exists = await this.dataSource.query(`
        SELECT 1 FROM timescaledb_information.continuous_aggregates
        WHERE view_schema = $1 AND view_name = 'metrics_1day'
      `, [schemaName]);

      if (day1Exists.length === 0) {
        await this.dataSource.query(`
          CREATE MATERIALIZED VIEW "${schemaName}"."metrics_1day"
          WITH (timescaledb.continuous) AS
          SELECT
            time_bucket('1 day', bucket) AS bucket,
            tenant_id,
            sensor_id,
            channel_id,
            tank_id,
            AVG(avg_value) AS avg_value,
            MIN(min_value) AS min_value,
            MAX(max_value) AS max_value,
            SQRT(AVG(POWER(COALESCE(stddev_value, 0), 2))) AS stddev_value,
            FIRST(first_value, bucket) AS open_value,
            LAST(last_value, bucket) AS close_value,
            SUM(sample_count) AS sample_count,
            SUM(good_count) AS good_count,
            SUM(bad_count) AS bad_count,
            (SUM(good_count)::FLOAT / NULLIF(SUM(sample_count), 0) * 100) AS quality_pct
          FROM "${schemaName}"."metrics_1hour"
          GROUP BY time_bucket('1 day', bucket), tenant_id, sensor_id, channel_id, tank_id
          WITH NO DATA
        `);

        await this.dataSource.query(`
          SELECT add_continuous_aggregate_policy(
            '"${schemaName}"."metrics_1day"',
            start_offset => INTERVAL '3 days',
            end_offset => INTERVAL '1 day',
            schedule_interval => INTERVAL '1 day',
            if_not_exists => TRUE
          )
        `);

        // No retention for daily - keep forever
        this.logger.log(`Created metrics_1day aggregate for ${schemaName}`);
      }

    } catch (error) {
      this.logger.warn(
        `Failed to create narrow table aggregates for ${schemaName}: ${(error as Error).message}`,
      );
    }
  }
}
