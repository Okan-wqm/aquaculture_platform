/**
 * Tenant-RBAC permission-override SSoT.
 *
 * A user's EFFECTIVE resource permissions = their assigned role's
 * `resource_permissions` with the per-assignment overrides applied:
 * revokes removed first, then grants added — so a `resource:action` present in
 * BOTH lists ends up granted (an explicit grant wins over a revoke).
 *
 * WHY this lives in one file: two code paths must produce byte-identical
 * effective sets or authorization silently diverges —
 *   1. TokenService.getUserResourcePermissions stamps the JWT `resourcePermissions`
 *      claim that the gateway assertion + TenantPermissionGuard actually enforce.
 *   2. TenantUserManagementService returns the "effective permissions" the
 *      tenant-admin UI shows the operator.
 * Before this util each side reimplemented the fold; the token path in fact
 * skipped overrides entirely (grants/revokes had zero runtime effect). Both now
 * import these pure functions, so what the admin configures is exactly what the
 * token carries.
 */
export interface PermissionOverrideSet {
  grants: string[];
  revokes: string[];
}

/**
 * Normalise a raw `permission_overrides` value — a jsonb column read back as an
 * object, a JSON string, or an already-parsed object — into a
 * `{ grants, revokes }` shape. Malformed / missing input degrades to empty
 * arrays, i.e. fail-closed to the role's base permissions (never throws, so a
 * data anomaly cannot abort a token mint).
 */
export function parsePermissionOverrides(raw: unknown): PermissionOverrideSet {
  if (!raw) {
    return { grants: [], revokes: [] };
  }

  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        const candidate = parsed as { grants?: unknown; revokes?: unknown };
        return {
          grants: Array.isArray(candidate.grants) ? (candidate.grants as string[]) : [],
          revokes: Array.isArray(candidate.revokes) ? (candidate.revokes as string[]) : [],
        };
      }
      return { grants: [], revokes: [] };
    } catch {
      return { grants: [], revokes: [] };
    }
  }

  if (typeof raw === 'object') {
    const obj = raw as { grants?: string[]; revokes?: string[] };
    return {
      grants: Array.isArray(obj.grants) ? obj.grants : [],
      revokes: Array.isArray(obj.revokes) ? obj.revokes : [],
    };
  }

  return { grants: [], revokes: [] };
}

/**
 * Apply per-user overrides to a role's base resource permissions.
 *
 * Order is load-bearing: revoke FIRST, then grant, so an explicit grant of the
 * same `resource:action` wins over a revoke of it. Returns a de-duplicated
 * array (Set-backed).
 */
export function applyPermissionOverrides(
  rolePermissions: string[],
  overrides: PermissionOverrideSet,
): string[] {
  const effective = new Set(rolePermissions);

  for (const revoke of overrides.revokes) {
    effective.delete(revoke);
  }

  for (const grant of overrides.grants) {
    effective.add(grant);
  }

  return Array.from(effective);
}
