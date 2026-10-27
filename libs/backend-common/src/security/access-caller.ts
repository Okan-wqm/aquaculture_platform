import {
  decideAccess,
  isModuleRole,
  moduleScopeOf,
  type AccessDecision,
  type AccessIntent,
  type AccessRequest,
  type MemberAccessSpec,
  type ModuleScope,
  type PlatformRole,
  type UserCaller,
} from '@aquaculture/shared-contracts';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import {
  recordModuleAccessDenied,
  type DeniedServiceLabel,
} from '../metrics/module-access-denied.metrics';

import {
  accessIntentOf,
  assignedSiteIdsOf,
  memberCallerOf,
  readHandlerAccess,
  requestUserOf,
} from './handler-access';

/**
 * AccessCaller — one handler's ADR-051 decision for one request (§3 "Resolver"; RBAC-HIGH-031).
 *
 * WHY recomputed per handler: sibling root fields of one GraphQL operation share one `req`, so a
 * decision a guard stored there could be read by another field (ADR-051, Alternatives). And Nest
 * runs no guard on a reference or field resolver, so those must decide themselves.
 * `resolveHandlerAccess` decides the handler from its own `@Access`/`@Roles` metadata and the
 * verified user, and nothing else; RolesGuard (`module-access`) and `@AccessCaller()` both call it.
 *
 * WHY a class with an ES private brand (as UserCaller, libs/shared-contracts/src/access/
 * user-caller.ts): a handler that receives an AccessCaller must be able to trust that a decision
 * allowed it. A spread, literal or JSON copy carries no private field, so the compiler rejects it
 * as an AccessCaller, and `isAccessCaller` refuses it. The class is exported as a type only;
 * `resolveHandlerAccess` is its one constructor and builds it only from an allowing decision.
 *
 * WHAT it holds:
 *   - `member`: the verified member caller, for a further decision the handler makes;
 *   - `spec`, `intent`: what was decided;
 *   - `effectiveRoles`: the account role, if any, then for `module(m)` the caller's role in m;
 *   - `moduleScope`: the modules the decision admits (the scope for `scoped`, m for `module(m)`),
 *     null for `company`, `self` and `account`;
 *   - `assignedSiteIds`: the caller's site assignments (a physical restriction, ADR-051 §1).
 */
class AccessCaller {
  readonly #decided = true;
  readonly member: UserCaller;
  readonly spec: MemberAccessSpec;
  readonly intent: AccessIntent;
  readonly effectiveRoles: readonly PlatformRole[];
  readonly moduleScope: ModuleScope | null;
  readonly assignedSiteIds: readonly string[];

  constructor(
    member: UserCaller,
    request: { readonly spec: MemberAccessSpec; readonly intent: AccessIntent },
    moduleScope: ModuleScope | null,
    assignedSiteIds: readonly string[],
  ) {
    this.member = member;
    this.spec = request.spec;
    this.intent = request.intent;
    this.effectiveRoles = effectiveRolesOf(member, request.spec);
    this.moduleScope = moduleScope;
    this.assignedSiteIds = assignedSiteIds;
    Object.freeze(this);
  }

  static carriesBrand(value: object): boolean {
    return #decided in value;
  }
}

export type { AccessCaller };

/** True only for an AccessCaller `resolveHandlerAccess` built from an allowing decision. */
export function isAccessCaller(value: unknown): value is AccessCaller {
  return typeof value === 'object' && value !== null && AccessCaller.carriesBrand(value);
}

function effectiveRolesOf(member: UserCaller, spec: MemberAccessSpec): readonly PlatformRole[] {
  const roles: PlatformRole[] = member.accountRole === null ? [] : [member.accountRole];
  if (spec.kind === 'module') {
    const grant: unknown = member.moduleAccess[spec.module];
    if (isModuleRole(grant)) roles.push(grant);
  }
  return Object.freeze(roles);
}

function scopeOf(spec: MemberAccessSpec, decision: AccessDecision): ModuleScope | null {
  if (decision.allowed && decision.kind === 'scoped') return decision.scope;
  if (spec.kind === 'module') return moduleScopeOf([spec.module]);
  return null;
}

/**
 * The decision for one handler. `company`, `self` and `account` read no `@Roles`
 * (AccessRequest), so a handler that pairs one of them with `@Roles` is denied, exactly as
 * decideAccess denies such a request (reason `roles`), rather than decided as though the roles
 * were absent; the classification invariant reports the pairing at build time.
 */
export function decideHandler(
  member: UserCaller,
  spec: MemberAccessSpec,
  intent: AccessIntent,
  roles: readonly PlatformRole[],
): AccessDecision {
  const request = accessRequestOf(spec, intent, roles);
  if (request === null) return Object.freeze({ allowed: false, kind: spec.kind, reason: 'roles' });
  return decideAccess(member, request);
}

function accessRequestOf(
  spec: MemberAccessSpec,
  intent: AccessIntent,
  roles: readonly PlatformRole[],
): AccessRequest | null {
  switch (spec.kind) {
    case 'module':
    case 'scoped':
      return { spec, intent, roles };
    case 'company':
    case 'self':
    case 'account':
      return roles.length === 0 ? { spec, intent } : null;
  }
}

const ACCESS_DENIED = 'Access denied';

/**
 * Decides the handler of `context` for its request and returns the AccessCaller, or throws:
 * ForbiddenException (counted in module_access_denied_total) when the handler declares no
 * `@Access`, no user is authenticated, or the decision denies; BadRequestException when a claim
 * of the verified user is malformed. `@Public()` is not read here: RolesGuard admits a public
 * handler before it asks, and a handler that asks for an AccessCaller asks for a decision.
 */
export function resolveHandlerAccess(
  reflector: Reflector,
  context: ExecutionContext,
  service: DeniedServiceLabel,
): AccessCaller {
  const { spec, roles } = readHandlerAccess(reflector, context);
  if (spec === undefined) {
    recordModuleAccessDenied(service, 'unclassified');
    throw new ForbiddenException(ACCESS_DENIED);
  }
  const user = requestUserOf(context);
  if (user === undefined) {
    recordModuleAccessDenied(service, spec.kind);
    throw new ForbiddenException(ACCESS_DENIED);
  }
  const member = memberCallerOf(user);
  const assignedSiteIds = assignedSiteIdsOf(user);
  const intent = accessIntentOf(reflector, context);
  const decision = decideHandler(member, spec, intent, roles);
  if (!decision.allowed) {
    recordModuleAccessDenied(service, spec.kind);
    throw new ForbiddenException(ACCESS_DENIED);
  }
  return new AccessCaller(member, { spec, intent }, scopeOf(spec, decision), assignedSiteIds);
}
