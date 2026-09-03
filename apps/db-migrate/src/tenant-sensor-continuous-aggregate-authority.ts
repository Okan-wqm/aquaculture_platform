import {
  queryRowsNormalized,
  SENSOR_CONTINUOUS_AGGREGATE_LOCK_PREFIX,
  SENSOR_CONTINUOUS_AGGREGATE_NAMES,
  SENSOR_CONTINUOUS_AGGREGATE_OWNER_ROLE,
  SENSOR_CONTINUOUS_AGGREGATE_RUNTIME_ROLE,
  SENSOR_CONTINUOUS_AGGREGATE_STATEMENTS,
  TENANT_SCHEMA_NAME_RE,
  validateTenantSchemaName,
} from '@aquaculture/backend-common/database';

export interface TenantSensorContinuousAggregateExecutor {
  /** Every call must use the same autocommit database session (QueryRunner). */
  query(sql: string, parameters?: readonly unknown[]): Promise<unknown>;
}

export interface TenantSensorContinuousAggregateAuthorityResult {
  readonly tenantSchema: string;
  readonly timescalePresent: boolean;
  readonly ownerRole: string;
  readonly runtimeRole: string;
  readonly aggregates: readonly string[];
}

function qualifiedName(schema: string, relation: string): string {
  return `"${schema}"."${relation}"`;
}

/**
 * Create/align one tenant's sensor rollups on an autocommit db-migrate
 * connection. Production runtime roles intentionally have no schema CREATE or
 * relation ownership, so this is the only production DDL path.
 */
export async function ensureTenantSensorContinuousAggregateAuthority(
  executor: TenantSensorContinuousAggregateExecutor,
  tenantSchema: string,
): Promise<TenantSensorContinuousAggregateAuthorityResult> {
  const schema = validateTenantSchemaName(tenantSchema);
  if (!TENANT_SCHEMA_NAME_RE.test(schema)) {
    throw new Error(`[db-migrate] Invalid tenant schema name for sensor aggregates: ${schema}`);
  }
  const extensionRows = queryRowsNormalized<{ exists: boolean }>(
    await executor.query(
      `SELECT EXISTS (
         SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'
       ) AS exists`,
    ),
  );

  if (extensionRows[0]?.exists !== true) {
    return {
      tenantSchema: schema,
      timescalePresent: false,
      ownerRole: SENSOR_CONTINUOUS_AGGREGATE_OWNER_ROLE,
      runtimeRole: SENSOR_CONTINUOUS_AGGREGATE_RUNTIME_ROLE,
      aggregates: [],
    };
  }

  const lockKey = `${SENSOR_CONTINUOUS_AGGREGATE_LOCK_PREFIX}${schema}`;
  await executor.query(`SELECT pg_advisory_lock(hashtext($1))`, [lockKey]);

  try {
    await executor.query(`SET search_path TO "${schema}", public`);
    const schemaRows = queryRowsNormalized<{ current_schema: string }>(
      await executor.query(`SELECT current_schema()`),
    );
    if (schemaRows[0]?.current_schema !== schema) {
      throw new Error(
        `[db-migrate] Failed to pin search_path to "${schema}" for sensor continuous aggregates ` +
          `(observed "${schemaRows[0]?.current_schema}").`,
      );
    }

    for (const statement of SENSOR_CONTINUOUS_AGGREGATE_STATEMENTS) {
      await executor.query(statement.sql);
    }

    for (const aggregate of SENSOR_CONTINUOUS_AGGREGATE_NAMES) {
      const relation = qualifiedName(schema, aggregate);
      await executor.query(
        `ALTER MATERIALIZED VIEW ${relation} OWNER TO ${SENSOR_CONTINUOUS_AGGREGATE_OWNER_ROLE}`,
      );
      await executor.query(
        `GRANT SELECT ON TABLE ${relation} TO ${SENSOR_CONTINUOUS_AGGREGATE_RUNTIME_ROLE}`,
      );
    }

    return {
      tenantSchema: schema,
      timescalePresent: true,
      ownerRole: SENSOR_CONTINUOUS_AGGREGATE_OWNER_ROLE,
      runtimeRole: SENSOR_CONTINUOUS_AGGREGATE_RUNTIME_ROLE,
      aggregates: [...SENSOR_CONTINUOUS_AGGREGATE_NAMES],
    };
  } finally {
    try {
      await executor.query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockKey]);
    } finally {
      await executor.query(`SET search_path TO "$user", public`);
    }
  }
}
