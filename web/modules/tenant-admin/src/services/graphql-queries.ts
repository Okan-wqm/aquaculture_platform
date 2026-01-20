/**
 * GraphQL Queries and Mutations for Tenant Admin
 */

// ============================================================================
// Queries
// ============================================================================

/**
 * Get current tenant information
 */
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

/**
 * Get tenant statistics
 */
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

/**
 * Get tenant's modules with details
 */
export const MY_TENANT_MODULES_QUERY = `
  query MyTenantModules {
    myTenantModules {
      id
      moduleId
      isEnabled
      configuration
      activatedAt
      expiresAt
      managerId
      module {
        id
        code
        name
        description
        icon
        category
        isActive
      }
    }
  }
`;

/**
 * Get tenant users
 */
export const TENANT_USERS_QUERY = `
  query TenantUsers($status: String, $role: String, $limit: Int, $offset: Int) {
    tenantUsers(status: $status, role: $role, limit: $limit, offset: $offset) {
      id
      email
      firstName
      lastName
      role
      status
      lastLoginAt
      createdAt
    }
  }
`;

/**
 * Get tenant database information
 */
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

/**
 * Get table schema information (columns and indexes)
 */
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

/**
 * Get table data with pagination (tenant-isolated)
 * Input requires schemaName and tableName separately
 */
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

/**
 * Assign module manager
 */
export const ASSIGN_MODULE_MANAGER_MUTATION = `
  mutation AssignModuleManager($input: AssignModuleManagerInput!) {
    assignModuleManager(input: $input) {
      id
      moduleId
      managerId
    }
  }
`;

/**
 * Remove module manager
 */
export const REMOVE_MODULE_MANAGER_MUTATION = `
  mutation RemoveModuleManager($moduleId: ID!) {
    removeModuleManager(moduleId: $moduleId) {
      id
      moduleId
      managerId
    }
  }
`;

/**
 * Update tenant settings
 */
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
