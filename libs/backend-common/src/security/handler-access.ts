import {
  MalformedCallerError,
  isPlatformRole,
  userCaller,
  type AccessIntent,
  type MemberAccessSpec,
  type PlatformRole,
  type UserCaller,
  type VerifiedMemberIdentity,
} from '@aquaculture/shared-contracts';
import { BadRequestException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { GqlExecutionContext, RESOLVER_TYPE_METADATA } from '@nestjs/graphql';

import { ACCESS_SPEC_KEY } from '../decorators/access.decorator';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../decorators/roles.decorator';

/**
 * What one handler declares and who calls it, read for an ADR-051 decision (RBAC-HIGH-030,
 * RBAC-HIGH-031). RolesGuard (`module-access` mode), AccessClassificationGuard and
 * `@AccessCaller()` read through these functions only, so they cannot disagree on a handler.
 *
 * Every reader is pure over the execution context: nothing is written to the request. Sibling root
 * fields of one GraphQL operation share one `req`, and Nest awaits the guards before the pipes run
 * (node_modules/@nestjs/core/helpers/external-context-creator.js), so a decision stored on `req`
 * could be read by another field (ADR-051, Alternatives).
 */

export interface HandlerAccess {
  /** `@Public()` decides the handler: the most specific declaration of the two is `@Public()`. */
  readonly isPublic: boolean;
  /** `@Access(...)` of the handler, else of its class; undefined when neither declares one. */
  readonly spec: MemberAccessSpec | undefined;
  /** `@Roles(...)` of the handler, else of its class; `[]` when neither names a role. */
  readonly roles: readonly PlatformRole[];
}

function rolesMetadata(value: unknown): readonly PlatformRole[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError('@Roles metadata is not a list of roles');
  const listed: readonly unknown[] = value;
  // A value that is no platform role would be dropped by a filter, and dropping a required role
  // widens the requirement; a malformed declaration is a programming error, so it throws.
  if (!listed.every(isPlatformRole)) throw new TypeError('@Roles names a value that is no role');
  return Object.freeze(listed.filter(isPlatformRole));
}

/**
 * Whether `@Public()` decides the handler, by specificity: the handler's own declaration beats its
 * class's, and on one target `@Access` beats `@Public()`. WHY: reading `@Public()` from the handler
 * or its class before `@Access` let a class-level `@Public()` admit a handler that declares its
 * own `@Access` to a caller without the grant, the more general declaration overriding the more
 * specific one (RBAC-HIGH-030's fail-open class). On one target `@Access` wins because it is the
 * side that fails closed. The classification invariant (rule 6) forbids every combination in which
 * this order has to choose; the order is what holds if one slips past it.
 */
function isPublicBySpecificity(reflector: Reflector, context: ExecutionContext): boolean {
  for (const target of [context.getHandler(), context.getClass()]) {
    if (reflector.get<MemberAccessSpec | undefined>(ACCESS_SPEC_KEY, target) !== undefined) {
      return false;
    }
    if (reflector.get<boolean | undefined>(IS_PUBLIC_KEY, target) === true) return true;
  }
  return false;
}

export function readHandlerAccess(reflector: Reflector, context: ExecutionContext): HandlerAccess {
  const targets = [context.getHandler(), context.getClass()];
  return Object.freeze({
    isPublic: isPublicBySpecificity(reflector, context),
    spec: reflector.getAllAndOverride<MemberAccessSpec | undefined>(ACCESS_SPEC_KEY, targets),
    roles: rolesMetadata(reflector.getAllAndOverride<unknown>(ROLES_KEY, targets)),
  });
}

const READ_VERBS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/**
 * The operation's intent (ADR-051 §3): a root Mutation writes; a Query, a Subscription, a field and
 * a reference resolver read; over HTTP, GET and HEAD read and every other verb writes.
 */
export function accessIntentOf(reflector: Reflector, context: ExecutionContext): AccessIntent {
  if (context.getType<string>() === 'graphql') {
    const rootType = reflector.get<unknown>(RESOLVER_TYPE_METADATA, context.getHandler());
    return rootType === 'Mutation' ? 'write' : 'read';
  }
  const request: unknown = context.switchToHttp().getRequest();
  const method =
    isRecord(request) && typeof request['method'] === 'string' ? request['method'] : '';
  return READ_VERBS.has(method.toUpperCase()) ? 'read' : 'write';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The verified user the middleware or JWT guard put on the request, as an untyped record. */
export interface RequestUser {
  readonly sub: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

function requestOf(context: ExecutionContext): unknown {
  if (context.getType<string>() === 'graphql') {
    const graphqlContext: unknown = GqlExecutionContext.create(context).getContext();
    return isRecord(graphqlContext) ? graphqlContext['req'] : undefined;
  }
  return context.switchToHttp().getRequest();
}

/**
 * The request's verified user, or undefined when none is authenticated. A user without a string
 * subject is no verified identity (the middleware sets `sub` from the assertion's subject).
 */
export function requestUserOf(context: ExecutionContext): RequestUser | undefined {
  const request = requestOf(context);
  if (!isRecord(request)) return undefined;
  const user = request['user'];
  if (!isRecord(user) || typeof user['sub'] !== 'string') return undefined;
  return Object.freeze({ sub: user['sub'], fields: user });
}

/**
 * The verified roles as one list: the deprecated single `role` first, then `roles`. A claim of
 * the wrong shape is passed on unchanged, so `userCaller` refuses it (MalformedCallerError).
 */
function verifiedRoles(fields: Readonly<Record<string, unknown>>): unknown {
  const role = fields['role'];
  const roles = fields['roles'];
  if (role === undefined) return roles;
  if (roles === undefined) return [role];
  if (!Array.isArray(roles)) return roles;
  const listed: readonly unknown[] = roles;
  return [role, ...listed];
}

function tenantOf(fields: Readonly<Record<string, unknown>>): string | null {
  const tenantId = fields['tenantId'];
  return typeof tenantId === 'string' ? tenantId : null;
}

export function memberIdentityOf(user: RequestUser): VerifiedMemberIdentity {
  return {
    userId: user.sub,
    tenantId: tenantOf(user.fields),
    roles: verifiedRoles(user.fields),
    moduleAccess: user.fields['moduleAccess'],
    capabilities: user.fields['resourcePermissions'],
  };
}

/**
 * The member caller of the request. A malformed claim is answered with 400, the mechanism
 * VerifiedUserAssertionMiddleware already uses for a malformed claim (ADR-051 §2: "malformed is
 * 400"); the message names the claim only, never its value.
 */
export function memberCallerOf(user: RequestUser): UserCaller {
  try {
    return userCaller(memberIdentityOf(user));
  } catch (error: unknown) {
    if (error instanceof MalformedCallerError) {
      throw new BadRequestException(`Verified user has invalid ${error.claim}`);
    }
    throw error;
  }
}

/** The caller's `assignedSiteIds` claim: absent means none; anything but strings is 400. */
export function assignedSiteIdsOf(user: RequestUser): readonly string[] {
  const value = user.fields['assignedSiteIds'];
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value))
    throw new BadRequestException('Verified user has invalid assignedSiteIds');
  const listed: readonly unknown[] = value;
  const siteIds = listed.filter((entry): entry is string => typeof entry === 'string');
  if (siteIds.length !== listed.length) {
    throw new BadRequestException('Verified user has invalid assignedSiteIds');
  }
  return Object.freeze(siteIds);
}
