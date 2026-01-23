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
}

/**
 * Supported modules and their table definitions
 */
export const MODULE_SCHEMAS: ModuleSchema[] = [
  {
    moduleName: 'sensor',
    sourceSchema: 'sensor',
    tables: [
      'sensors',
      'sensor_readings',
      'sensor_metrics',       // New narrow table for time-series data
      'sensor_data_channels',
      'sensor_protocols',
      'processes',
      'vfd_devices',
      'vfd_readings',
      'vfd_register_mappings',
      'dashboard_layouts',    // User dashboard layout persistence
      'edge_devices',         // Edge controllers (Revolution Pi, Raspberry Pi, etc.)
    ],
  },
  {
    moduleName: 'farm',
    sourceSchema: 'farm',
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

      // Maintenance
      'maintenance_schedules',
      'work_orders',

      // Feed management
      'feed_types',
      'feed_type_species',
      'feeds',
      'feed_inventory',
      'feed_sites',
      'feeding_protocols',
      'feeding_records',
      'feeding_tables',

      // Chemical management
      'chemical_types',
      'chemicals',
      'chemical_sites',

      // Production tracking
      'growth_measurements',
      'mortality_records',
      'water_quality_measurements',
      'health_events',
      'harvest_plans',
      'harvest_records',

      // Suppliers
      'supplier_types',
      'suppliers',

      // Supporting tables
      'code_sequences',
      'farm_audit_logs',

      // Regulatory settings (Maskinporten credentials, company info)
      'regulatory_settings',
    ],
  },
  {
    moduleName: 'hr',
    sourceSchema: 'hr',
    tables: [
      // Core Employee & Payroll
      'employees',
      'payrolls',

      // Organizational Structure
      'departments_hr',
      'positions',
      'salary_structures',

      // Leave Management
      'leave_types',
      'leave_balances',
      'leave_requests',

      // Attendance & Scheduling
      'shifts',
      'schedules',
      'schedule_entries',
      'attendance_records',

      // Performance Management
      'performance_reviews',
      'performance_goals',
      'employee_kpis',

      // Training
      'training_courses',
      'training_sessions',
      'training_enrollments',

      // Certifications (Aquaculture-specific)
      'certification_types',
      'employee_certifications',

      // Aquaculture-specific
      'work_areas',
      'work_rotations',
      'safety_training_records',
    ],
  },
];

/**
 * Reference data tables to copy for each module
 * These tables contain lookup/configuration data that should be available in each tenant schema
 */
export const REFERENCE_DATA_TABLES: Record<string, string[]> = {
  farm: [
    'equipment_types',
    'sub_equipment_types',
    'supplier_types',
    'chemical_types',
    'feed_types',
  ],
  hr: [
    'leave_types',
    'certification_types',
    'shifts',
  ],
  sensor: [
    'sensor_protocols',
  ],
};

/**
 * Schema creation result
 */
export interface SchemaCreationResult {
  success: boolean;
  schemaName: string;
  tablesCreated: string[];
  referenceDataCopied: { table: string; rows: number }[];
  errors: string[];
  duration: number;
  alreadyExists?: boolean;
}

/**
 * Simple LRU Cache implementation for schema existence checks
 * Prevents excessive database queries for repeated checks
 */
class SchemaLRUCache {
  private cache = new Map<string, { value: boolean; expiry: number }>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize = 1000, ttlMs = 5 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: string): boolean | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return undefined;
    }
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: boolean): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, expiry: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * Schema Manager Service
 * Manages tenant-specific PostgreSQL schemas for complete data isolation
 *
 * Features:
 * - Advisory locks for race condition prevention
 * - LRU caching for schema existence checks
 * - SQL injection prevention via UUID validation
 * - Reference data copying for lookup tables
 * - Atomic schema creation with cleanup on failure
 */
@Injectable()
export class SchemaManagerService {
  private readonly logger = new Logger(SchemaManagerService.name);

  /** LRU cache for schema existence checks (max 1000 entries, 5 min TTL) */
  private readonly schemaCache = new SchemaLRUCache(1000, 5 * 60 * 1000);

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
   */
  private getAdvisoryLockKey(tenantId: string): number {
    const hash = crypto.createHash('md5').update(tenantId).digest();
    return hash.readInt32LE(0);
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
    modules: string[] = ['sensor', 'farm', 'hr'],
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
          schemaName,
          tablesCreated: [],
          referenceDataCopied: [],
          errors: [],
          duration: Date.now() - startTime,
          alreadyExists: true,
        };
      }

      this.logger.log(`Creating tenant schema: ${schemaName} for tenant ${tenantId}`);

      // 1. Create the schema
      await this.dataSource.query(`CREATE SCHEMA "${schemaName}"`);
      this.logger.debug(`Schema ${schemaName} created`);

      // 2. Create tables for each requested module
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
              await this.dataSource.query(`
                CREATE TABLE "${schemaName}"."${tableName}"
                (LIKE "${moduleSchema.sourceSchema}"."${tableName}" INCLUDING ALL)
              `);
              tablesCreated.push(`${schemaName}.${tableName}`);
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

      // 3. Copy reference data for each module
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

      // 4. Grant permissions (using current database user)
      await this.dataSource.query(`
        GRANT USAGE ON SCHEMA "${schemaName}" TO CURRENT_USER
      `);

      await this.dataSource.query(`
        GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA "${schemaName}" TO CURRENT_USER
      `);

      await this.dataSource.query(`
        GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "${schemaName}" TO CURRENT_USER
      `);

      // Update cache
      this.schemaCache.set(schemaName, true);

      const totalRefRows = referenceDataCopied.reduce((sum, r) => sum + r.rows, 0);
      this.logger.log(
        `Tenant schema ${schemaName} created: ${tablesCreated.length} tables, ${totalRefRows} reference rows in ${Date.now() - startTime}ms`,
      );

      return {
        success: errors.length === 0,
        schemaName,
        tablesCreated,
        referenceDataCopied,
        errors,
        duration: Date.now() - startTime,
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
   */
  private async copyReferenceDataTable(
    targetSchema: string,
    sourceSchema: string,
    tableName: string,
  ): Promise<number> {
    // Check if target table exists
    const targetExists = await this.tableExists(targetSchema, tableName);
    if (!targetExists) {
      this.logger.debug(`Target table ${targetSchema}.${tableName} does not exist, skipping copy`);
      return 0;
    }

    // Check if source table exists and has data
    const sourceExists = await this.tableExists(sourceSchema, tableName);
    if (!sourceExists) {
      this.logger.debug(`Source table ${sourceSchema}.${tableName} does not exist, skipping copy`);
      return 0;
    }

    // Check if target already has data (avoid duplicate copies)
    const existingCount = await this.dataSource.query(
      `SELECT COUNT(*) as count FROM "${targetSchema}"."${tableName}"`,
    );
    if (parseInt(existingCount[0]?.count || '0', 10) > 0) {
      this.logger.debug(`Target table ${targetSchema}.${tableName} already has data, skipping copy`);
      return 0;
    }

    // Get source row count first
    const sourceCountResult = await this.dataSource.query(
      `SELECT COUNT(*) as count FROM "${sourceSchema}"."${tableName}"`,
    );
    const sourceCount = parseInt(sourceCountResult[0]?.count || '0', 10);

    if (sourceCount === 0) {
      this.logger.debug(`Source table ${sourceSchema}.${tableName} is empty, skipping copy`);
      return 0;
    }

    // Copy data from source to target
    await this.dataSource.query(`
      INSERT INTO "${targetSchema}"."${tableName}"
      SELECT * FROM "${sourceSchema}"."${tableName}"
    `);

    // Verify rows were copied by counting target
    const targetCountResult = await this.dataSource.query(
      `SELECT COUNT(*) as count FROM "${targetSchema}"."${tableName}"`,
    );
    const rowsCopied = parseInt(targetCountResult[0]?.count || '0', 10);

    this.logger.debug(`Copied ${rowsCopied} rows to ${targetSchema}.${tableName}`);
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
      this.schemaCache.delete(schemaName);

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
    this.schemaCache.delete(schemaName);
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
   * Create continuous aggregates for efficient charting
   * Pre-aggregates data at hourly and daily intervals
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
   */
  async migrateDataToTenantSchema(
    tenantId: string,
    sourceSchema: string,
    tableName: string,
  ): Promise<{ rowsMigrated: number; error?: string }> {
    const schemaName = this.getTenantSchemaName(tenantId);

    try {
      this.logger.log(
        `Migrating data from ${sourceSchema}.${tableName} to ${schemaName}.${tableName}`,
      );

      // Count rows before migration
      const beforeCountResult = await this.dataSource.query(
        `SELECT COUNT(*) as count FROM "${schemaName}"."${tableName}"`,
      );
      const beforeCount = parseInt(beforeCountResult[0]?.count || '0', 10);

      // Insert data with tenant filter
      await this.dataSource.query(`
        INSERT INTO "${schemaName}"."${tableName}"
        SELECT * FROM "${sourceSchema}"."${tableName}"
        WHERE "tenantId" = $1
        ON CONFLICT DO NOTHING
      `, [tenantId]);

      // Count rows after migration to get actual migrated count
      const afterCountResult = await this.dataSource.query(
        `SELECT COUNT(*) as count FROM "${schemaName}"."${tableName}"`,
      );
      const afterCount = parseInt(afterCountResult[0]?.count || '0', 10);
      const rowsMigrated = afterCount - beforeCount;

      this.logger.log(`Migrated ${rowsMigrated} rows to ${schemaName}.${tableName}`);

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
   */
  async setTenantSearchPath(tenantId: string): Promise<void> {
    const schemaName = this.getTenantSchemaName(tenantId);
    await this.dataSource.query(`SET search_path TO "${schemaName}", public`);
  }

  /**
   * Set search_path within a transaction (connection-safe)
   * Use this for reliable tenant isolation in connection pools
   *
   * @example
   * await dataSource.transaction(async (manager) => {
   *   await schemaManager.setTenantSearchPathInTransaction(manager, tenantId);
   *   // All queries in this transaction will use tenant schema
   *   await manager.query('SELECT * FROM sensors');
   * });
   */
  async setTenantSearchPathInTransaction(
    manager: { query: (sql: string) => Promise<unknown> },
    tenantId: string,
  ): Promise<void> {
    const schemaName = this.getTenantSchemaName(tenantId);
    await manager.query(`SET LOCAL search_path TO "${schemaName}", public`);
  }

  /**
   * Reset search_path to default
   *
   * WARNING: Same connection pool limitations as setTenantSearchPath()
   */
  async resetSearchPath(): Promise<void> {
    await this.dataSource.query(`SET search_path TO public`);
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
