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
    acknowledgments: (id: string) =>
      [...adminKeys.announcements.all(), 'acknowledgments', id] as const,
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
    // Per tenant: the retention route refuses a request without a tenant id,
    // and a key without one would show one tenant's deletion windows under
    // another tenant's view (ADMIN-CRITICAL-151).
    retention: (tenantId: string) =>
      [...adminKeys.messaging.all(), 'retention', tenantId] as const,
    compliance: () => [...adminKeys.messaging.all(), 'compliance'] as const,
    // Both are PER TENANT — the routes reject a request without a tenant id,
    // and a key without one would serve one tenant's legal holds under
    // another tenant's view (ADMIN-CRITICAL-147).
    complianceStats: (tenantId: string) =>
      [...adminKeys.messaging.compliance(), 'stats', tenantId] as const,
    legalHolds: (tenantId: string) =>
      [...adminKeys.messaging.compliance(), 'legal-holds', tenantId] as const,
    monitoring: () => [...adminKeys.messaging.all(), 'monitoring'] as const,
    // Keyed by the request, cursor included: the audit route is
    // cursor-paginated, so two pages of the same filters are different reads
    // and must not share a cache entry (ADMIN-CRITICAL-150).
    audit: (request?: Record<string, unknown>) =>
      [...adminKeys.messaging.all(), 'audit', request] as const,
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
    plans: (includeInactive = false) =>
      [...adminKeys.billing.all(), 'plans', includeInactive] as const,
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
    /**
     * The metered-usage dashboard's four reads. Usage drives invoices, so each
     * carries its own discriminators: a trend for one period must not overwrite
     * another's, nor a top-tenants list for one meter another meter's.
     */
    usageSummary: (period: string) => [...adminKeys.billing.all(), 'usage-summary', period] as const,
    usageTenants: (params?: Record<string, unknown>) =>
      [...adminKeys.billing.all(), 'usage-tenants', params] as const,
    usageTrends: (period: string, numPeriods: number) =>
      [...adminKeys.billing.all(), 'usage-trends', period, numPeriods] as const,
    usageTopTenants: (meterType: string, period: string) =>
      [...adminKeys.billing.all(), 'usage-top-tenants', meterType, period] as const,
    /** The custom-plan approval queue, per filter and page. */
    customPlans: (filters?: Record<string, unknown>) =>
      [...adminKeys.billing.all(), 'custom-plans', filters] as const,
    /** Discount codes, per listing filter. */
    discountCodes: (filters?: Record<string, unknown>) =>
      [...adminKeys.billing.all(), 'discount-codes', filters] as const,
    /** The discount aggregate. */
    discountStats: () => [...adminKeys.billing.all(), 'discount-stats'] as const,
    /** The subscription list, per filter and page. */
    subscriptions: (filters?: Record<string, unknown>) =>
      [...adminKeys.billing.all(), 'subscriptions', filters] as const,
    /** The subscription aggregate — the server's, not derived from the page. */
    subscriptionStats: () => [...adminKeys.billing.all(), 'subscription-stats'] as const,
    /** The payment list, per filter. */
    payments: (filters?: Record<string, unknown>) =>
      [...adminKeys.billing.all(), 'payments', filters] as const,
    /** The platform-wide payment aggregate — NOT derived from the page above. */
    paymentStats: () => [...adminKeys.billing.all(), 'payment-stats'] as const,
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
