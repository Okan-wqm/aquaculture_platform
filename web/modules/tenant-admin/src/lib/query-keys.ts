/**
 * Centralized Query Key Factory
 *
 * CRIT-04: Single source of truth for all TanStack Query keys
 * used throughout the tenant-admin module. Prevents key drift
 * and makes cache invalidation predictable.
 */

const BASE = ['tenant'] as const;

export const tenantKeys = {
  all: BASE,
  detail: () => [...BASE, 'detail'] as const,
  stats: () => [...BASE, 'stats'] as const,
  users: {
    all: [...BASE, 'users'] as const,
    list: (filters?: Record<string, unknown>) =>
      [...BASE, 'users', 'list', filters] as const,
    detail: (id: string) => [...BASE, 'users', 'detail', id] as const,
  },
  modules: {
    all: [...BASE, 'modules'] as const,
    list: () => [...BASE, 'modules', 'list'] as const,
  },
  roles: {
    all: [...BASE, 'roles'] as const,
    list: () => [...BASE, 'roles', 'list'] as const,
  },
  billing: {
    all: [...BASE, 'billing'] as const,
  },
  database: {
    all: [...BASE, 'database'] as const,
    schema: (table: string) =>
      [...BASE, 'database', 'schema', table] as const,
  },
  devices: {
    all: [...BASE, 'devices'] as const,
    detail: (id: string) => [...BASE, 'devices', id] as const,
  },
  communication: {
    threads: () => [...BASE, 'threads'] as const,
    tickets: () => [...BASE, 'tickets'] as const,
    announcements: () => [...BASE, 'announcements'] as const,
  },
} as const;
