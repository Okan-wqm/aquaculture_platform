import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { moduleAccessServiceLabel } from '../metrics/module-access-denied.metrics';
import {
  resolveHandlerAccess,
  type AccessCaller as DecidedAccessCaller,
} from '../security/access-caller';

/**
 * `@AccessCaller()` — the handler's own ADR-051 decision, as a branded AccessCaller (§3
 * "Resolver"; RBAC-HIGH-031).
 *
 * It recomputes `decideAccess` from the handler's and class's `@Access`/`@Roles` and the verified
 * `req.user`, and stores nothing on the request, so each aliased root field gets only its own
 * scope. It is the decision point where no guard runs: every `@ResolveReference` and every
 * `@ResolveField` of a `module-access` service takes it (or the field is parent-scoped, see
 * security/parent-scoped-fields.ts). It throws ForbiddenException on a deny and when neither the
 * handler nor its class declares `@Access`, and answers a malformed claim with 400.
 *
 * ```ts
 * @Access.scoped('workforce')
 * @Query(() => [Employee])
 * employees(@AccessCaller() caller: AccessCaller): Promise<Employee[]> { ... }
 * ```
 */
export type AccessCaller = DecidedAccessCaller;

/** Stateless; the param factory runs outside dependency injection. */
const reflector = new Reflector();

const accessCallerParam = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AccessCaller =>
    resolveHandlerAccess(reflector, context, moduleAccessServiceLabel()),
);

export function AccessCaller(): ParameterDecorator {
  return accessCallerParam();
}
