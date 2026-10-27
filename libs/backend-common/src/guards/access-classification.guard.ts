import { ForbiddenException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { recordModuleAccessDenied } from '../metrics/module-access-denied.metrics';
import type { AccessEnrolledService } from '../security/access-enrolment';
import { readHandlerAccess } from '../security/handler-access';

/**
 * AccessClassificationGuard — an unclassified operation fails closed (ADR-051 §3 step 2;
 * RBAC-HIGH-030).
 *
 * WHY: RolesGuard admitted any authenticated caller when a handler declared no `@Roles`, and
 * TenantPermissionGuard passes a handler without its decorator, so an unannotated hr or sensor
 * operation answered every member of the tenant; only farm-service failed closed, through a
 * private matrix. In a `module-access` service this guard denies every root Query/Mutation field
 * and REST handler that has neither `@Access(...)` nor `@Public()`, on the handler or its class.
 * A classified handler under a class-level `@Public()` passes here as classified, and RolesGuard
 * decides it: its own `@Access` is the more specific declaration (handler-access.ts).
 *
 * It is registered only by `accessGuardProviders` for a `module-access` service, before
 * RolesGuard, so an `account-role` service is unchanged. Nest runs no guard on a reference or
 * field resolver; those decide through `@AccessCaller()`, and the classification invariant fails
 * one that does not. It reads metadata only and stores nothing on the request. It has no
 * injectable constructor: the service it labels its denials with comes from the enrolment key.
 */
export class AccessClassificationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly service: AccessEnrolledService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const access = readHandlerAccess(this.reflector, context);
    if (access.isPublic || access.spec !== undefined) return true;
    recordModuleAccessDenied(this.service, 'unclassified');
    throw new ForbiddenException('Access denied');
  }
}
