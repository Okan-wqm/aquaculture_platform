/**
 * permissionsAdapter — maps a BUILDER widget permission definition onto the
 * RUNTIME permission shape consumed by useOperatorPermission.
 *
 * Mapping source (documented per architect demand):
 *   - Builder side (`WidgetPermissions` in types/scada-widget.types.ts):
 *     { showRoles, enableRoles } where the arrays hold TENANT ROLE IDs
 *     (arbitrary strings assigned in the tenant's IAM).
 *   - Runtime side (`WidgetPermission` in types/scada-runtime.types.ts):
 *     { showRoles, enabledRoles } where the arrays hold HmiRole literals
 *     ('viewer' | 'operator' | 'engineer' | 'supervisor' | 'admin').
 *   - The mapping is NAME-BASED: a tenant role id resolves when its
 *     normalized form (lower-cased, common prefixes like `role_`/`hmi_`
 *     stripped) equals an HmiRole literal. The authoritative HmiRole for a
 *     session comes from operatorSlice.currentUserRole, which is written
 *     from the server's AUTH push (JWT role) — the client never invents a
 *     stronger role.
 *
 * Degradation: ids that do not resolve to an HmiRole are DROPPED with a
 * visible warning (fail-open: an unresolvable id cannot prove either
 * membership or exclusion, and disabling every widget of a package that uses
 * tenant role ids would brick the HMI). The warning makes the degradation
 * discoverable instead of silent.
 */

import type { WidgetPermissions } from '../../../types/scada-widget.types';
import type { HmiRole, WidgetPermission } from '../../../types/scada-runtime.types';

export const HMI_ROLES: readonly HmiRole[] = [
  'viewer',
  'operator',
  'engineer',
  'supervisor',
  'admin',
] as const;

/** Prefixes tenant IAM systems commonly add to role ids. */
const ROLE_ID_PREFIXES = ['role_', 'hmi_', 'scada_'];

/** Normalize a tenant role id toward an HmiRole literal, if possible. */
export function resolveHmiRole(roleId: string): HmiRole | null {
  let candidate = roleId.trim().toLowerCase();
  for (const prefix of ROLE_ID_PREFIXES) {
    if (candidate.startsWith(prefix)) {
      candidate = candidate.slice(prefix.length);
      break;
    }
  }
  return (HMI_ROLES as readonly string[]).includes(candidate) ? (candidate as HmiRole) : null;
}

export interface AdaptedPermission {
  permission: WidgetPermission;
  /** Visible degradation notes (unresolvable role ids etc.). */
  warnings: string[];
}

/** Missing/undefined permissions adapt to the fully-open default. */
export function adaptWidgetPermissions(
  builderPermissions: WidgetPermissions | undefined,
): AdaptedPermission {
  if (!builderPermissions) {
    return {
      permission: { showRoles: [], enabledRoles: [] },
      warnings: [],
    };
  }

  const warnings: string[] = [];

  const adaptRoleList = (ids: string[], field: 'showRoles' | 'enableRoles'): HmiRole[] => {
    const resolved: HmiRole[] = [];
    for (const id of ids) {
      const role = resolveHmiRole(id);
      if (role) {
        resolved.push(role);
      } else {
        warnings.push(
          `permissionsAdapter: ${field} id "${id}" does not map to any HmiRole — dropped (fail-open)`,
        );
      }
    }
    return resolved;
  };

  return {
    permission: {
      showRoles: adaptRoleList(builderPermissions.showRoles ?? [], 'showRoles'),
      enabledRoles: adaptRoleList(builderPermissions.enableRoles ?? [], 'enableRoles'),
    },
    warnings,
  };
}
