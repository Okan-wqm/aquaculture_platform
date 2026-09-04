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
// Localization (W5)
// ============================================================================

/**
 * Tenant saat dilimi + dil. Saat dilimi bir görünüm tercihi DEĞİLDİR: farm
 * modülünün yemleme cron'ları (plan üretimi, sabah süpürmesi, gün özeti, FCR
 * ve stok kapsama süpürmeleri) tenant'ın YEREL gününde koşar ve gün sınırını
 * bu ayardan alır.
 */
export const MY_TENANT_LOCALIZATION_QUERY = `
  query MyTenantLocalization {
    myTenantLocalization {
      timezone
      locale
    }
  }
`;

export const UPDATE_TENANT_LOCALIZATION_MUTATION = `
  mutation UpdateTenantLocalization($input: UpdateTenantLocalizationInput!) {
    updateTenantLocalization(input: $input) {
      timezone
      locale
    }
  }
`;
