/**
 * Admin Query Key Factory
 *
 * Centralized query key definitions for TanStack React Query cache management.
 * Every query in the admin-panel should reference keys from this factory so
 * that mutations can surgically invalidate the right slices of the cache.
 *
 * Pattern follows the tenant-admin module's `tenantKeys` convention:
 *   - `all` is the root -- invalidating it clears the entire admin cache
 *   - Each domain has a namespace function that returns a tuple
 *   - Parameterized keys spread additional discriminators into the tuple
 *
 * @see web/modules/tenant-admin/src/hooks/useTenantData.ts for the reference pattern
 */

export const adminKeys = {
  /** Root key -- invalidate this to clear ALL admin-panel queries */
  all: ['admin'] as const,

  // ── Announcements ──
  announcements: {
    all: () => [...adminKeys.all, 'announcements'] as const,
    list: (filters?: Record<string, unknown>) =>
      [...adminKeys.announcements.all(), 'list', filters] as const,
    detail: (id: string) =>
      [...adminKeys.announcements.all(), 'detail', id] as const,
    stats: () => [...adminKeys.announcements.all(), 'stats'] as const,
  },

  // ── Messaging / Support Threads ──
  messaging: {
    all: () => [...adminKeys.all, 'messaging'] as const,
    threads: (filters?: Record<string, unknown>) =>
      [...adminKeys.messaging.all(), 'threads', filters] as const,
    thread: (id: string) =>
      [...adminKeys.messaging.all(), 'thread', id] as const,
    messages: (threadId: string) =>
      [...adminKeys.messaging.all(), 'messages', threadId] as const,
    stats: () => [...adminKeys.messaging.all(), 'stats'] as const,
    retention: () => [...adminKeys.messaging.all(), 'retention'] as const,
    compliance: () => [...adminKeys.messaging.all(), 'compliance'] as const,
    complianceStats: () => [...adminKeys.messaging.compliance(), 'stats'] as const,
    legalHolds: () => [...adminKeys.messaging.compliance(), 'legal-holds'] as const,
    monitoring: () => [...adminKeys.messaging.all(), 'monitoring'] as const,
    audit: () => [...adminKeys.messaging.all(), 'audit'] as const,
    tenants: () => [...adminKeys.messaging.all(), 'tenants'] as const,
    personas: () => [...adminKeys.messaging.all(), 'personas'] as const,
  },

  // ── Tenants ──
  tenants: {
    all: () => [...adminKeys.all, 'tenants'] as const,
    list: (filters?: Record<string, unknown>) =>
      [...adminKeys.tenants.all(), 'list', filters] as const,
    detail: (id: string) =>
      [...adminKeys.tenants.all(), 'detail', id] as const,
    stats: () => [...adminKeys.tenants.all(), 'stats'] as const,
  },

  // ── Users ──
  users: {
    all: () => [...adminKeys.all, 'users'] as const,
    list: (filters?: Record<string, unknown>) =>
      [...adminKeys.users.all(), 'list', filters] as const,
    detail: (id: string) =>
      [...adminKeys.users.all(), 'detail', id] as const,
    /** The platform-wide user counts behind the four cards. */
    stats: () => [...adminKeys.users.all(), 'stats'] as const,
    /** The assignable-role catalogue — a read no user write invalidates. */
    roleTemplates: () => [...adminKeys.users.all(), 'role-templates'] as const,
    /** The role hierarchy and the permission catalogue behind RoleManagementPage. */
    roleHierarchy: () => [...adminKeys.users.all(), 'role-hierarchy'] as const,
    permissionCatalogue: () => [...adminKeys.users.all(), 'permission-catalogue'] as const,
    rolePermissions: (roleCode: string) =>
      [...adminKeys.users.all(), 'role-permissions', roleCode] as const,
  },

  // ── Modules ──
  modules: {
    all: () => [...adminKeys.all, 'modules'] as const,
    // Takes the filters, like every other domain's `list`. Without them a
    // filtered module list would overwrite the unfiltered one in the same
    // cache entry — the class of bug this factory exists to prevent.
    list: (filters?: Record<string, unknown>) =>
      [...adminKeys.modules.all(), 'list', filters] as const,
    detail: (id: string) =>
      [...adminKeys.modules.all(), 'detail', id] as const,
  },

  // ── System ──
  system: {
    all: () => [...adminKeys.all, 'system'] as const,
    health: () => [...adminKeys.system.all(), 'health'] as const,
    /** Root for the performance dashboard's three independent reads. */
    performance: () => [...adminKeys.system.all(), 'performance'] as const,
    settings: () => [...adminKeys.system.all(), 'settings'] as const,
    analytics: () => [...adminKeys.system.all(), 'analytics'] as const,
  },

  // ── Security ──
  security: {
    all: () => [...adminKeys.all, 'security'] as const,
    audit: (filters?: Record<string, unknown>) =>
      [...adminKeys.security.all(), 'audit', filters] as const,
    sessions: () => [...adminKeys.security.all(), 'sessions'] as const,
  },

  // ── Billing ──
  billing: {
    all: () => [...adminKeys.all, 'billing'] as const,
    invoices: (filters?: Record<string, unknown>) =>
      [...adminKeys.billing.all(), 'invoices', filters] as const,
    plans: () => [...adminKeys.billing.all(), 'plans'] as const,
    /** The module price sheet the tenant-creation wizard prices a selection from. */
    modulePricing: () => [...adminKeys.billing.all(), 'module-pricing'] as const,
    /**
     * The billing overview's five composed stat reads, under one key: the page
     * renders them as a single answer, so a partially-refreshed set would put
     * one endpoint's number beside another's staleness under one heading.
     */
    dashboardMetrics: () => [...adminKeys.billing.all(), 'dashboard-metrics'] as const,
    /** The revenue series. Range AND granularity belong in the key. */
    revenueTrend: (range: string, granularity: string) =>
      [...adminKeys.billing.all(), 'revenue-trend', range, granularity] as const,
    /** The five money totals above the invoice table. */
    invoiceStats: () => [...adminKeys.billing.all(), 'invoice-stats'] as const,
    /** The newest invoices behind the "Recent Transactions" feed. */
    recentInvoices: (limit: number) =>
      [...adminKeys.billing.all(), 'recent-invoices', limit] as const,
  },

  // ── Onboarding (support) ──
  onboarding: {
    all: () => [...adminKeys.all, 'onboarding'] as const,
    steps: () => [...adminKeys.onboarding.all(), 'steps'] as const,
    list: (filters?: Record<string, unknown>) =>
      [...adminKeys.onboarding.all(), 'list', filters] as const,
    stats: () => [...adminKeys.onboarding.all(), 'stats'] as const,
    resources: () => [...adminKeys.onboarding.all(), 'resources'] as const,
  },

  // ── Reports ──
  reports: {
    all: () => [...adminKeys.all, 'reports'] as const,
    list: () => [...adminKeys.reports.all(), 'list'] as const,
    detail: (id: string) =>
      [...adminKeys.reports.all(), 'detail', id] as const,
  },

  // ── Database ──
  database: {
    all: () => [...adminKeys.all, 'database'] as const,
    schemas: () => [...adminKeys.database.all(), 'schemas'] as const,
    tables: (schema?: string) =>
      [...adminKeys.database.all(), 'tables', schema] as const,
    /**
     * Prefix covering every page and sort order of ONE table — the key a row
     * write invalidates. `tableData` extends it, so React Query's prefix
     * matching reaches page 7 sorted descending from a delete performed on
     * page 1.
     */
    table: (schema: string, table: string) =>
      [...adminKeys.database.all(), 'data', schema, table] as const,
    /**
     * One entry per (page, limit, sort). The params belong IN the key for the
     * same reason they do in `modules.list`: without them page 2 overwrites
     * page 1 in a single cache entry and the explorer shows the wrong rows
     * under the right page number.
     */
    tableData: (
      schema: string,
      table: string,
      params: Record<string, unknown>,
    ) => [...adminKeys.database.table(schema, table), params] as const,

    // ── Database management (schemas, migrations, monitoring) ──
    /** The tracked tenant-schema rows, filtered/paged. */
    tenantSchemas: (filters?: Record<string, unknown>) =>
      [...adminKeys.database.all(), 'tenant-schemas', filters] as const,
    /** The server's platform-wide schema totals — NOT derived from the page above. */
    summary: () => [...adminKeys.database.all(), 'summary'] as const,
    migrationPlans: () => [...adminKeys.database.all(), 'migration-plans'] as const,
    migrationHistory: (filters?: Record<string, unknown>) =>
      [...adminKeys.database.all(), 'migration-history', filters] as const,
    health: () => [...adminKeys.database.all(), 'health'] as const,
    connections: () => [...adminKeys.database.all(), 'connections'] as const,
    storage: () => [...adminKeys.database.all(), 'storage'] as const,
    slowQueries: (params?: Record<string, unknown>) =>
      [...adminKeys.database.all(), 'slow-queries', params] as const,
    indexRecommendations: (schemaName?: string) =>
      [...adminKeys.database.all(), 'index-recommendations', schemaName] as const,
  },
} as const;
