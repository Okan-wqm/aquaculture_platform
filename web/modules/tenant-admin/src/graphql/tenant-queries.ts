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
// Tenant auth-security policy (ADR-046)
//
// TENANT_ADMIN-guarded auth-service subgraph. The policy is ENFORCED — the
// login MFA gate reads enforceMfa, and the refresh-TTL clamp inside
// TokenService.generateTokens reads sessionTimeoutMinutes. tenantId is never
// an input: the server derives it from the caller's JWT.
//
// Localization (timezone/locale) is a DIFFERENT authority with its own
// surface (updateTenantLocalization, written through the tenant
// command-receipt path) and is deliberately not folded in here.
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
