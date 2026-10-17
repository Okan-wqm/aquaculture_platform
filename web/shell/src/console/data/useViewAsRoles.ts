/**
 * useViewAsRoles — the tenant's roles and their capabilities, for the user
 * menu's "view as role".
 *
 * WHY: a role preview filters the console through the role's resource
 * permissions (the same `resource:action` strings hasResourcePermission checks),
 * so it needs the real roles, not the design's sample set. auth-service
 * tenantRoles is guarded by roles:view, so the hook asks only when the viewer
 * holds it. A role whose permission row is absent (`permissions` is nullable in
 * the schema) grants nothing — the backend's own fail-closed reading.
 *
 * WHAT: StatusResult<{ roles }>, in the server's order. `enabled: false`
 * leaves it 'unavailable' without a request — the console offers the role
 * preview to tenant admins only (design decision D20), so a delegate holding
 * roles:view does not fetch a list nobody shows them.
 */
import { graphqlClient, useTenantQuery } from '@aquaculture/shared-ui';
import type {
  TenantRole,
  TenantRolePermissions,
} from '@platform/shared-ui/generated/graphql-types';

import { TENANT_ROLES_QUERY } from './console.operations';
import { resultFrom, type Nulled, type StatusResult } from './dataStatus';
import { useConsoleDataAccess } from './useConsoleDataAccess';

export interface ViewAsRole {
  id: string;
  name: string;
  description: string | null;
  color: string;
  level: number;
  isSystem: boolean;
  resourcePermissions: readonly string[];
}

export type ViewAsRoles = StatusResult<{ roles: readonly ViewAsRole[] }>;

type RoleRow = Pick<TenantRole, 'id' | 'name' | 'description' | 'color' | 'level' | 'isSystem'> & {
  permissions?: Pick<TenantRolePermissions, 'resourcePermissions'> | null;
};

const NO_ROLES: Nulled<{ roles: readonly ViewAsRole[] }> = { roles: null };

/** Roles change only through the roles page; the menu tolerates a 5-minute-old list. */
const ROLES_STALE_MS = 5 * 60_000;

function toViewAsRole(row: RoleRow): ViewAsRole {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    color: row.color,
    level: row.level,
    isSystem: row.isSystem,
    resourcePermissions: row.permissions?.resourcePermissions ?? [],
  };
}

export interface ViewAsRolesOptions {
  /** False keeps the list unavailable and unfetched; true by default. */
  readonly enabled?: boolean;
}

export function useViewAsRoles({ enabled = true }: ViewAsRolesOptions = {}): ViewAsRoles {
  const access = useConsoleDataAccess();
  const readable = access.roles && enabled;
  const query = useTenantQuery(
    ['console', 'viewAsRoles'],
    async ({ signal }): Promise<ViewAsRole[]> => {
      const data = await graphqlClient.request<{ tenantRoles: RoleRow[] }>(
        TENANT_ROLES_QUERY,
        undefined,
        { signal },
      );
      return data.tenantRoles.map(toViewAsRole);
    },
    { enabled: readable, staleTime: ROLES_STALE_MS },
  );

  return resultFrom(query, readable, NO_ROLES, (roles) => ({ roles }));
}
