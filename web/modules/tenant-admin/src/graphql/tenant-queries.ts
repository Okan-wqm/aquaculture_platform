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

export const UPDATE_TENANT_SETTINGS_MUTATION = `
  mutation UpdateTenantSettings($input: UpdateTenantInput!) {
    updateTenantSettings(input: $input) {
      id
      name
      description
      logoUrl
      contactEmail
      contactPhone
      address
      settings
      updatedAt
    }
  }
`;
