import { ForbiddenException, Injectable } from '@nestjs/common';

import { Role, roleHasPermission } from '../decorators/roles.decorator';

/**
 * Caller identity for an object-level site authorization check.
 *
 * `sub` is the authenticated auth-service userId (JWT subject). `roles` are the
 * canonical {@link Role} values the JWT guard has already validated.
 * `assignedSiteIds` are the farm-service Site ids the user is assigned to,
 * minted into the JWT (`assignedSiteIds` claim) and threaded through the
 * gateway verified-user assertion to reach the resolver.
 */
export interface SiteScopeCaller {
  sub: string;
  roles: Role[];
  assignedSiteIds?: string[];
}

export interface AssertSiteAssignmentArgs {
  caller: SiteScopeCaller;
  /**
   * The site the mutated object (batch/tank/location) resolves to, in the SAME
   * identity namespace as `caller.assignedSiteIds` (a farm-service Site id).
   * `null`/`undefined` means the site could NOT be resolved — an unresolved
   * site is never an implicit allow (fail-closed).
   */
  siteId: string | null | undefined;
}

export type SiteAccessScope = { kind: 'TENANT' } | { kind: 'ASSIGNED'; siteIds: readonly string[] };

/**
 * SEC-HIGH-051 — canonical object-level site authorization SSoT.
 *
 * WHY: object-level mutations on a batch/tank/location must only be allowed for
 * a user assigned to that record's SITE. Coarse `@Roles(...)` gates only prove
 * tenant membership, so without this any MODULE_USER could mutate ANY batch in
 * their tenant regardless of physical site. This is the tier-1 layer BENEATH
 * the role gate (defense-in-depth, like {@link assertSelfOrManager}).
 *
 * WHAT: allow iff
 *   (a) the caller holds MODULE_MANAGER or higher via the canonical role
 *       hierarchy (`roleHasPermission(role, Role.MODULE_MANAGER)`) — managers
 *       own cross-site operations, OR
 *   (b) the resolved `siteId` is in the caller's `assignedSiteIds`.
 * Otherwise throw `ForbiddenException`.
 *
 * FAIL-CLOSED: a `null`/`undefined` `siteId` (unresolved site) for a non-manager
 * => deny; a `siteId` NOT in `assignedSiteIds` (or an empty/absent set) for a
 * non-manager => deny. The MODULE_MANAGER+ bypass flows through the canonical
 * {@link roleHasPermission} hierarchy — never a parallel string check.
 *
 * SSoT: this is the ONE site-authorization vocabulary. Every farm handler that
 * needs object-level site authz calls THIS — no duplicated checks.
 */
@Injectable()
export class SiteAuthorizationService {
  /**
   * Resolves the database scope for site collection reads.
   *
   * Managers and higher roles receive tenant-wide access. Every other caller
   * receives an explicit assigned-site scope; an absent or empty assignment is
   * represented by an empty list so query handlers can apply a fail-closed
   * predicate instead of accidentally omitting the authorization filter.
   */
  resolveSiteScope(caller: SiteScopeCaller): SiteAccessScope {
    const isManagerOrHigher = caller.roles.some((role) =>
      roleHasPermission(role, Role.MODULE_MANAGER),
    );
    if (isManagerOrHigher) {
      return { kind: 'TENANT' };
    }

    return {
      kind: 'ASSIGNED',
      siteIds: [...new Set(caller.assignedSiteIds ?? [])],
    };
  }

  assertSiteAssignment(args: AssertSiteAssignmentArgs): void {
    const { caller, siteId } = args;

    const scope = this.resolveSiteScope(caller);
    if (scope.kind === 'TENANT') {
      return;
    }

    // (b) fail-closed: an unresolved site is never an implicit allow.
    if (siteId == null) {
      throw new ForbiddenException('Access denied');
    }

    // (c) fail-closed: the resolved site must be in the caller's assigned set.
    if (!scope.siteIds.includes(siteId)) {
      throw new ForbiddenException('Access denied');
    }
  }
}
