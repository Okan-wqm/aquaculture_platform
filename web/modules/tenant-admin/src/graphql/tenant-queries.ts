/**
 * GraphQL queries and mutations for core tenant operations:
 * tenant info, stats, database, table schema/data, settings.
 */

// ============================================================================
// Queries
// ============================================================================

export const MY_TENANT_QUERY = `
  query MyTenant {
    myTenant {
      id
      name
      slug
      description
      logoUrl
      contactEmail
      contactPhone
      address
      status
      plan
      maxUsers
      settings
      createdAt
      updatedAt
    }
  }
`;

export const TENANT_STATS_QUERY = `
  query TenantStats {
    tenantStats {
      totalUsers
      activeUsers
      pendingUsers
      inactiveUsers
      totalModules
      activeModules
      activeSessions
      monthlyGrowthPercent
      lastActivityAt
    }
  }
`;

export const TENANT_DATABASE_QUERY = `
  query TenantDatabase {
    tenantDatabase {
      databaseName
      schemaName
      totalSize
      tableCount
      status
      lastBackup
      activeConnections
      maxConnections
      databaseType
      region
      isolationLevel
      encryption
      tables {
        name
        rowCount
        size
        indexCount
        lastModified
      }
    }
  }
`;

export const TABLE_SCHEMA_QUERY = `
  query TableSchema($schemaName: String!, $tableName: String!) {
    tableSchema(schemaName: $schemaName, tableName: $tableName) {
      tableName
      schemaName
      columns {
        columnName
        dataType
        isNullable
        columnDefault
        isPrimaryKey
        isForeignKey
        foreignKeyTable
        foreignKeyColumn
      }
      indexes {
        indexName
        columnName
        isUnique
        isPrimary
      }
    }
  }
`;

export const TABLE_DATA_QUERY = `
  query TableData($input: GetTableDataInput!) {
    tableData(input: $input) {
      tableName
      totalRows
      columns
      rows
      offset
      limit
    }
  }
`;

// ============================================================================
// Mutations
// ============================================================================

export const UPDATE_TENANT_MUTATION = `
  mutation UpdateTenant($id: ID!, $input: UpdateTenantInput!) {
    updateTenant(id: $id, input: $input) {
      id
      name
      slug
      description
      logoUrl
      contactEmail
      contactPhone
      address
      status
      plan
      maxUsers
      settings
      createdAt
      updatedAt
    }
  }
`;

/**
 * Backward-compatible alias for UPDATE_TENANT_MUTATION.
 * @deprecated Use UPDATE_TENANT_MUTATION instead.
 */
export const UPDATE_TENANT_SETTINGS_MUTATION = UPDATE_TENANT_MUTATION;

// ============================================================================
// Tenant security policy + localization preferences (ADR-045)
//
// TENANT_ADMIN-guarded auth-service subgraph. The security policy is ENFORCED
// (login MFA gate + refresh-TTL clamp); the localization preferences are
// display-only. tenantId is never an input — it derives from the caller's JWT.
// `dateFormat` is a GraphQL enum (TenantDateFormat): the wire values are the
// enum NAMES (DD_MM_YYYY / MM_DD_YYYY / YYYY_MM_DD), which the server maps to
// the 'DD/MM/YYYY'-style stored value.
// ============================================================================

export const TENANT_SECURITY_POLICY_QUERY = `
  query TenantSecurityPolicy {
    tenantSecurityPolicy {
      enforceMfa
      sessionTimeoutMinutes
    }
  }
`;

export const UPDATE_TENANT_SECURITY_POLICY_MUTATION = `
  mutation UpdateTenantSecurityPolicy($input: UpdateTenantSecurityPolicyInput!) {
    updateTenantSecurityPolicy(input: $input) {
      enforceMfa
      sessionTimeoutMinutes
    }
  }
`;

export const TENANT_LOCALIZATION_PREFERENCES_QUERY = `
  query TenantLocalizationPreferences {
    tenantLocalizationPreferences {
      timezone
      dateFormat
    }
  }
`;

export const UPDATE_TENANT_LOCALIZATION_PREFERENCES_MUTATION = `
  mutation UpdateTenantLocalizationPreferences(
    $input: UpdateTenantLocalizationPreferencesInput!
  ) {
    updateTenantLocalizationPreferences(input: $input) {
      timezone
      dateFormat
    }
  }
`;
