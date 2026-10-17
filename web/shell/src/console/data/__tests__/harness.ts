/**
 * Shared test plumbing for the console data hooks.
 *
 * WHY: every hook runs on the real useTenantQuery (tenant key + session gate),
 * so each spec needs a fresh QueryClient with retries off — a failed fetch must
 * surface as status 'error' at once instead of after three back-offs. The
 * vi.mock calls themselves stay in each spec (vitest hoists them per file);
 * this module only builds the provider and the auth fixture shape they share.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement, type ReactNode } from 'react';

/** The auth facts the hooks read, mutated per test through vi.hoisted. */
export interface AuthFixture {
  token: string | null;
  tenantId: string | null;
  isTenantAdmin: boolean;
  permissions: string[];
  modules: Array<{ code: string; name: string; defaultRoute: string }>;
}

export function defaultAuth(): AuthFixture {
  return { token: 'tok', tenantId: 'tenant-1', isTenantAdmin: false, permissions: [], modules: [] };
}

export function moduleOf(code: string): { code: string; name: string; defaultRoute: string } {
  return { code, name: code, defaultRoute: `/${code}` };
}

/** The useAuth surface the hooks and useTenantQuery read, backed by the fixture. */
export function authFrom(auth: AuthFixture): {
  token: string | null;
  tenantId: string | null;
  isTenantAdmin: boolean;
  hasPermission: (permission: string) => boolean;
} {
  return {
    token: auth.token,
    tenantId: auth.tenantId,
    isTenantAdmin: auth.isTenantAdmin,
    // Mirrors the shared capability rule: admins bypass, everyone else is checked.
    hasPermission: (permission: string): boolean =>
      auth.isTenantAdmin || auth.permissions.includes(permission),
  };
}

export function createWrapper(): {
  client: QueryClient;
  wrapper: (props: { children: ReactNode }) => ReactElement;
} {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }): ReactElement =>
    createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}
