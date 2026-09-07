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
  },

  // ── Modules ──
  modules: {
    all: () => [...adminKeys.all, 'modules'] as const,
    list: () => [...adminKeys.modules.all(), 'list'] as const,
    detail: (id: string) =>
      [...adminKeys.modules.all(), 'detail', id] as const,
  },

  // ── System ──
  system: {
    all: () => [...adminKeys.all, 'system'] as const,
    health: () => [...adminKeys.system.all(), 'health'] as const,
    settings: () => [...adminKeys.system.all(), 'settings'] as const,
    analytics: () => [...adminKeys.system.all(), 'analytics'] as const,
  },

  // ── Security ──
  security: {
    all: () => [...adminKeys.all, 'security'] as const,
    audit: (filters?: Record<string, unknown>) =>
      [...adminKeys.security.all(), 'audit', filters] as const,
  },

  // ── Billing ──
  billing: {
    all: () => [...adminKeys.all, 'billing'] as const,
    invoices: (filters?: Record<string, unknown>) =>
      [...adminKeys.billing.all(), 'invoices', filters] as const,
    plans: () => [...adminKeys.billing.all(), 'plans'] as const,
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
    tables: (schema?: string) =>
      [...adminKeys.database.all(), 'tables', schema] as const,
    tableData: (schema: string, table: string) =>
      [...adminKeys.database.all(), 'data', schema, table] as const,
  },
} as const;
