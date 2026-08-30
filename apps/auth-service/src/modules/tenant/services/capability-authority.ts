import { Role } from '@aquaculture/backend-common/decorators';
import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';

import { User } from '../../authentication/entities/user.entity';

import {
  CATALOGUE_CAPABILITIES,
  requiredModuleFor,
  resolveEntitledCapabilities,
} from './permission-catalogue';
import { applyPermissionOverrides, parsePermissionOverrides } from './permission-overrides.util';

/**
 * The nominal brand key. A value carrying this property has passed
 * `CapabilityAuthorityService` validation — the branded types below can only be
 * produced by this service's `assert*` methods (they are the sole functions that
 * attach the brand), so a capability write that skipped the authority + catalogue
 * check is a COMPILE ERROR at every persistence call site (Tier-1
 * make-it-impossible). The brand is stripped before serialization, never stored.
 */
const VALIDATED_BRAND = '__capabilityAuthorityValidated' as const;

/**
 * A `resource:action` list proven to be (a) in the catalogue and (b) grantable
 * by the acting user. Required by every path that writes
 * `tenant_role_permissions.resource_permissions`.
 */
export type GrantablePermissionSet = string[] & { readonly [VALIDATED_BRAND]: true };

/**
 * A `{ grants, revokes }` override pair proven catalogue-valid, with `grants`
 * additionally proven grantable by the acting user. Required by every path that
 * writes `user_role_assignments.permission_overrides`.
 */
export type ValidatedOverrideSet = {
  grants: string[];
  revokes: string[];
  readonly [VALIDATED_BRAND]: true;
};

/**
 * The acting user's grant authority within a tenant:
 * - `isTenantAdmin` — a global SUPER_ADMIN / TENANT_ADMIN resolved INSIDE this
 *   tenant. They define the tenant's roles, so they may grant any catalogue
 *   capability (the subset check is skipped; the catalogue whitelist still holds).
 * - `effective` — a non-admin actor's own effective resource permissions. They
 *   may grant ONLY a subset of this (the "cannot grant more than you have"
 *   invariant). Empty for admins (who bypass the subset check) and for an
 *   unresolved / cross-tenant actor (who can grant nothing — fail-closed).
 * - `entitled` — the capabilities the TENANT's plan/modules license
 *   (RBAC-HIGH-010). Enforced for EVERYONE, admins included: even a
 *   TENANT_ADMIN cannot grant a capability for a module the tenant does not
 *   license (revenue integrity + it would mint a capability no subgraph should
 *   honour). Independent of the actor's own `effective` set.
 */
export interface ActorAuthority {
  isTenantAdmin: boolean;
  effective: ReadonlySet<string>;
  entitled: ReadonlySet<string>;
}

/**
 * Write-time RBAC grant authority — the single enforcement point for the two
 * invariants tenant-configurable delegation previously lacked on EVERY write
 * path (role create/edit, assignment, per-user override, user creation):
 *   1. Catalogue whitelist — a capability outside PERMISSION_CATEGORIES can
 *      never be persisted (closes arbitrary `resource:action` injection).
 *   2. "Cannot grant more than you have" — a non-admin delegate may only grant
 *      capabilities that are a subset of their own effective set (closes the
 *      in-tenant privilege-escalation via role authoring / override grants).
 *
 * The branded return types make bypass structural: the persistence helpers
 * accept only `GrantablePermissionSet` / `ValidatedOverrideSet`, and only the
 * `assert*` methods here produce them.
 */
@Injectable()
export class CapabilityAuthorityService {
  private readonly logger = new Logger(CapabilityAuthorityService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Resolve the acting user's grant authority, PINNED to the acting tenant
   * (ORPHAN-CRITICAL-100 pattern): a user id that does not resolve inside this
   * tenant yields an authority that can grant nothing, so a cross-tenant caller
   * cannot use their home-tenant privileges to grant here.
   */
  async resolveActorAuthority(tenantId: string, actorUserId: string): Promise<ActorAuthority> {
    const actor = await this.userRepository.findOne({ where: { id: actorUserId, tenantId } });
    if (!actor) {
      // Unknown / cross-tenant actor: fail-closed, grants nothing. Entitlement
      // is irrelevant when the actor can grant nothing at all.
      return { isTenantAdmin: false, effective: new Set<string>(), entitled: new Set<string>() };
    }

    // RBAC-HIGH-010: the tenant's licensed capability set, enforced for admins
    // and delegates alike. Resolved via the shared SSoT (enabled tenant_modules
    // ∩ catalogue category→module map). `resolveTenantEntitled` is a private
    // wrapper so the two return paths share one call.
    if (actor.role === Role.SUPER_ADMIN || actor.role === Role.TENANT_ADMIN) {
      return {
        isTenantAdmin: true,
        effective: new Set<string>(),
        entitled: await this.resolveTenantEntitled(tenantId),
      };
    }

    // Non-admin actor: their ceiling is their OWN effective resource permissions.
    // Same tenant-pinned two-table JOIN + override fold TokenService uses to mint
    // the JWT claim, so "what I may grant" equals exactly "what I hold".
    const rows = rowsAs<{ resource_permissions: string[] | null; permission_overrides: unknown }>(
      await this.dataSource.query(
        `
        SELECT trp.resource_permissions, ura.permission_overrides
        FROM "auth"."user_role_assignments" ura
        JOIN "auth"."tenant_roles" tr ON ura.role_id = tr.id
        JOIN "auth"."tenant_role_permissions" trp ON ura.role_id = trp.role_id
        WHERE ura.user_id = $1 AND ura.is_active = true AND tr."tenantId" = $2
        `,
        [actorUserId, tenantId],
      ),
    );

    const roleBase = new Set<string>();
    let overrides = { grants: [] as string[], revokes: [] as string[] };
    for (const row of rows) {
      if (Array.isArray(row.resource_permissions)) {
        for (const perm of row.resource_permissions) {
          roleBase.add(perm);
        }
      }
      overrides = parsePermissionOverrides(row.permission_overrides);
    }

    return {
      isTenantAdmin: false,
      effective: new Set(applyPermissionOverrides(Array.from(roleBase), overrides)),
      entitled: await this.resolveTenantEntitled(tenantId),
    };
  }

  /**
   * The tenant's licensed capability set (RBAC-HIGH-010) via the shared SSoT.
   */
  private resolveTenantEntitled(tenantId: string): Promise<ReadonlySet<string>> {
    return resolveEntitledCapabilities(
      (sql, params) => this.dataSource.query(sql, params as unknown[]),
      tenantId,
    );
  }

  /**
   * Validate a role's derived resource permissions and stamp them grantable.
   * Deduplicates, rejects any capability outside the catalogue, and — for a
   * non-admin actor — rejects any capability the actor does not themselves hold.
   */
  assertGrantableResourcePermissions(
    requested: readonly string[],
    actor: ActorAuthority,
  ): GrantablePermissionSet {
    const deduped = Array.from(new Set(requested));
    this.assertKnownCapabilities(deduped, 'grant');
    // Entitlement is enforced for EVERYONE (admins included) — a capability for
    // a module the tenant does not license can never be persisted.
    this.assertEntitled(deduped, actor);
    if (!actor.isTenantAdmin) {
      this.assertSubsetOfActor(deduped, actor);
    }
    return Object.assign(deduped, { [VALIDATED_BRAND]: true as const });
  }

  /**
   * Validate a per-user override pair and stamp it validated. `grants` are
   * catalogue-checked AND authority-checked (subset of the actor's effective set
   * unless admin); `revokes` are catalogue-checked only (revoking a capability
   * never needs authority — you can always remove access).
   */
  assertGrantableOverrides(
    overrides: { grants?: readonly string[]; revokes?: readonly string[] } | null | undefined,
    actor: ActorAuthority,
  ): ValidatedOverrideSet {
    const grants = Array.from(new Set(overrides?.grants ?? []));
    const revokes = Array.from(new Set(overrides?.revokes ?? []));
    this.assertKnownCapabilities(grants, 'grant');
    this.assertKnownCapabilities(revokes, 'revoke');
    // Grants are entitlement-checked (revokes never are — removing access to an
    // unlicensed capability must always be permitted, e.g. to clean up a stale
    // grant after a plan downgrade).
    this.assertEntitled(grants, actor);
    if (!actor.isTenantAdmin) {
      this.assertSubsetOfActor(grants, actor);
    }
    return { grants, revokes, [VALIDATED_BRAND]: true as const };
  }

  /**
   * A validated empty override set, for assignment paths that carry no per-user
   * overrides (e.g. the create-on-assign branch). Trivially valid — no grants to
   * authorize — so it needs no actor context.
   */
  emptyOverrides(): ValidatedOverrideSet {
    return { grants: [], revokes: [], [VALIDATED_BRAND]: true as const };
  }

  /** Serialize a validated override set for jsonb storage, WITHOUT the brand. */
  static serializeOverrides(overrides: ValidatedOverrideSet): string {
    return JSON.stringify({ grants: overrides.grants, revokes: overrides.revokes });
  }

  private assertKnownCapabilities(capabilities: readonly string[], verb: 'grant' | 'revoke'): void {
    const unknown = capabilities.filter((capability) => !CATALOGUE_CAPABILITIES.has(capability));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Cannot ${verb} unknown capabilit${unknown.length === 1 ? 'y' : 'ies'}: ${unknown.join(', ')}. ` +
          'Only capabilities defined in the permission catalogue are allowed.',
      );
    }
  }

  private assertEntitled(capabilities: readonly string[], actor: ActorAuthority): void {
    const unentitled = capabilities.filter((capability) => !actor.entitled.has(capability));
    if (unentitled.length > 0) {
      const detail = unentitled
        .map(
          (capability) =>
            `${capability} (requires the ${requiredModuleFor(capability) ?? '?'} module)`,
        )
        .join(', ');
      throw new ForbiddenException(
        `Cannot grant capabilit${unentitled.length === 1 ? 'y' : 'ies'} the tenant's plan does not license: ${detail}. ` +
          'Enable the module for this tenant first.',
      );
    }
  }

  private assertSubsetOfActor(capabilities: readonly string[], actor: ActorAuthority): void {
    const beyond = capabilities.filter((capability) => !actor.effective.has(capability));
    if (beyond.length > 0) {
      throw new ForbiddenException(
        `You cannot grant capabilit${beyond.length === 1 ? 'y' : 'ies'} you do not hold: ${beyond.join(', ')}.`,
      );
    }
  }
}

/**
 * Raw-SQL trust boundary: dataSource.query returns untyped rows. The call site
 * declares the row shape its SELECT projects, so the any never propagates.
 */
function rowsAs<T extends object>(result: unknown): readonly T[] {
  return Array.isArray(result) ? (result as readonly T[]) : [];
}
