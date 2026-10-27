/**
 * The module-access reader — the one answer to "which modules may this user open, and as what"
 * (ADR-051 §2 "Source"; RBAC-HIGH-027, RBAC-MEDIUM-029).
 *
 * WHY: token mint held two readers with different predicates. TENANT_ADMIN read
 * tenant_modules with `isEnabled`; every other user read their assignments with no join, so a
 * module the tenant had removed stayed in each member's claim on every refresh. alert and ai
 * assignments came out as module grants (against D4), and the per-module manager choice was
 * dropped, leaving the tenant-wide users.role as the only level.
 *
 * WHAT: `readModuleAccess(query, principal)` reads once and answers three things:
 *   - `moduleAccess`, the claim: owner module → MODULE_MANAGER | MODULE_USER. A member's grants
 *     are their assignment rows' roles, joined to the tenant's enabled modules; TENANT_ADMIN
 *     holds every enabled owner module as MODULE_MANAGER (OQ1); SUPER_ADMIN holds none (it acts
 *     on the platform, and decideAccess gives it the platform pass). users.role grants nothing.
 *   - `modules`, the legacy `modules` list (JWT claim, `me.modules`, the login redirect) that
 *     the release-R1 web still reads (C1): every enabled module the user may open, alert and ai
 *     included, as before — now joined to `isEnabled` for members too.
 *   - `dropped`: what the claim left out, by reason — a module that owns no data (alert, ai), a
 *     code the dictionary does not hold, or a row without a role (written by a container of the
 *     previous release; PKG-06 re-runs the backfill in R3). The mint counts them.
 *
 * Every read is authoritative (no cache) and goes through the caller's query function, so the
 * mint and the `me` query read the same rows in the caller's transaction context.
 */
import {
  OWNER_MODULE_CODES,
  PLATFORM_ROLE,
  accountRoleOf,
  isModuleRole,
  isOwnerModuleCode,
  isPlatformModuleCode,
  platformRoleSatisfies,
  type ModuleAccess,
  type ModuleRole,
  type OwnerModuleCode,
} from '@aquaculture/shared-contracts';

export type ModuleAccessQuery = (sql: string, params: readonly unknown[]) => Promise<unknown>;

/** The columns of the user the reader decides by. */
export interface ModuleAccessPrincipal {
  readonly id: string;
  /** users.role: only its account role (TENANT_ADMIN, SUPER_ADMIN) is read. */
  readonly role: string;
  readonly tenantId: string | null;
}

/** One entry of the legacy `modules` list. */
export interface UserModuleSummary {
  readonly code: string;
  readonly name: string;
  readonly defaultRoute: string;
}

export const MODULE_ACCESS_DROP_REASONS = Object.freeze([
  'not_owner_module',
  'unknown_code',
  'role_missing',
] as const);

export type ModuleAccessDropReason = (typeof MODULE_ACCESS_DROP_REASONS)[number];

export type ModuleAccessDrops = { readonly [Reason in ModuleAccessDropReason]: number };

export interface ModuleAccessRead {
  readonly moduleAccess: ModuleAccess;
  readonly modules: readonly UserModuleSummary[];
  readonly dropped: ModuleAccessDrops;
}

/** SUPER_ADMIN: every active platform module (it has no tenant). */
const PLATFORM_MODULES_SQL = `
  SELECT code, name, "defaultRoute"
    FROM auth.modules
   WHERE "isActive" = true
   ORDER BY "sortOrder" ASC, name ASC`;

/** TENANT_ADMIN: every module the tenant has enabled. */
const TENANT_MODULES_SQL = `
  SELECT m.code, m.name, m."defaultRoute"
    FROM auth.tenant_modules tm
    JOIN auth.modules m ON tm."moduleId" = m.id
   WHERE tm."tenantId" = $1 AND tm."isEnabled" = true
   ORDER BY m.name`;

/**
 * A member: their live assignments in the token's tenant whose module the tenant still has
 * enabled. The primary module comes first, so the login redirect lands on it.
 */
const MEMBER_MODULES_SQL = `
  SELECT m.code, m.name, m."defaultRoute", uma."role"
    FROM auth.user_module_assignments uma
    JOIN auth.modules m ON m.id = uma."moduleId"
    JOIN auth.tenant_modules tm ON tm."tenantId" = uma."tenantId" AND tm."moduleId" = uma."moduleId"
   WHERE uma."userId" = $1 AND uma."tenantId" = $2
     AND uma."isActive" = true
     AND (uma."expiresAt" IS NULL OR uma."expiresAt" >= now())
     AND tm."isEnabled" = true
   ORDER BY uma."isPrimaryManager" DESC, uma."createdAt" ASC, m.name ASC`;

interface ModuleRow {
  readonly summary: UserModuleSummary;
  readonly role: unknown;
}

/** A row whose code, name and route are text; anything else is no module of the catalogue. */
function moduleRowOf(row: unknown): ModuleRow | null {
  if (typeof row !== 'object' || row === null) return null;
  const code: unknown = Reflect.get(row, 'code');
  const name: unknown = Reflect.get(row, 'name');
  const defaultRoute: unknown = Reflect.get(row, 'defaultRoute');
  if (typeof code !== 'string' || typeof name !== 'string' || typeof defaultRoute !== 'string') {
    return null;
  }
  return { summary: Object.freeze({ code, name, defaultRoute }), role: Reflect.get(row, 'role') };
}

class ModuleAccessBuilder {
  private readonly grants = new Map<OwnerModuleCode, ModuleRole>();
  private readonly modules: UserModuleSummary[] = [];
  private readonly dropped: { [Reason in ModuleAccessDropReason]: number } = {
    not_owner_module: 0,
    unknown_code: 0,
    role_missing: 0,
  };

  /** Lists a row without deriving a grant from it (SUPER_ADMIN holds none by design). */
  list(row: unknown): void {
    const parsed = moduleRowOf(row);
    if (parsed !== null) this.modules.push(parsed.summary);
  }

  /** Lists a row and grants `grantedRole(row)` in its module when that is a module role. */
  grant(row: unknown, grantedRole: (row: ModuleRow) => unknown): void {
    const parsed = moduleRowOf(row);
    if (parsed === null) {
      this.dropped.unknown_code += 1;
      return;
    }
    this.modules.push(parsed.summary);
    const { code } = parsed.summary;
    if (!isPlatformModuleCode(code)) {
      this.dropped.unknown_code += 1;
      return;
    }
    if (!isOwnerModuleCode(code)) {
      this.dropped.not_owner_module += 1;
      return;
    }
    const role = grantedRole(parsed);
    if (!isModuleRole(role)) {
      this.dropped.role_missing += 1;
      return;
    }
    const held = this.grants.get(code);
    if (held === undefined || !platformRoleSatisfies(held, role)) this.grants.set(code, role);
  }

  build(): ModuleAccessRead {
    const moduleAccess: { [Code in OwnerModuleCode]?: ModuleRole } = {};
    for (const code of OWNER_MODULE_CODES) {
      const role = this.grants.get(code);
      if (role !== undefined) moduleAccess[code] = role;
    }
    return Object.freeze({
      moduleAccess: Object.freeze(moduleAccess),
      modules: Object.freeze([...this.modules]),
      dropped: Object.freeze({ ...this.dropped }),
    });
  }
}

function rowsOf(result: unknown): readonly unknown[] {
  return Array.isArray(result) ? result : [];
}

export async function readModuleAccess(
  query: ModuleAccessQuery,
  principal: ModuleAccessPrincipal,
): Promise<ModuleAccessRead> {
  const builder = new ModuleAccessBuilder();
  const accountRole = accountRoleOf([principal.role]);
  if (accountRole === PLATFORM_ROLE.SUPER_ADMIN) {
    // The platform pass is decideAccess's; the list is the platform catalogue, no grant.
    for (const row of rowsOf(await query(PLATFORM_MODULES_SQL, []))) builder.list(row);
    return builder.build();
  }
  if (principal.tenantId === null) return builder.build();
  if (accountRole === PLATFORM_ROLE.TENANT_ADMIN) {
    for (const row of rowsOf(await query(TENANT_MODULES_SQL, [principal.tenantId]))) {
      builder.grant(row, () => PLATFORM_ROLE.MODULE_MANAGER);
    }
    return builder.build();
  }
  const memberRows = await query(MEMBER_MODULES_SQL, [principal.id, principal.tenantId]);
  for (const row of rowsOf(memberRows)) builder.grant(row, (parsed) => parsed.role);
  return builder.build();
}
