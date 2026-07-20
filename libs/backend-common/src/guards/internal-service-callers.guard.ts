import {
  CanActivate,
  type CustomDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { TenantRequest } from '../types/tenant-request.interface';

export const INTERNAL_SERVICE_CALLERS_METADATA = 'platform:internal-service-callers';

/**
 * Declare the exact verified service identities permitted to call an internal
 * HTTP handler. An empty/missing declaration never grants access.
 */
export const RequireInternalServiceCallers = (
  ...serviceNames: readonly string[]
): CustomDecorator<string> => SetMetadata(INTERNAL_SERVICE_CALLERS_METADATA, [...serviceNames]);

/**
 * REST-only authorization layer over StripInternalHeadersMiddleware's verified
 * v2 identity. It does not inspect caller-controlled identity headers itself.
 */
@Injectable()
export class InternalServiceCallersGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      throw new ForbiddenException('Verified internal service identity is required');
    }
    const allowed = this.reflector.getAllAndOverride<readonly string[]>(
      INTERNAL_SERVICE_CALLERS_METADATA,
      [context.getHandler(), context.getClass()],
    );
    const request = context.switchToHttp().getRequest<TenantRequest>();
    const caller = request.verifiedIdentity?.serviceName;

    if (!allowed || allowed.length < 1 || !caller || !allowed.includes(caller)) {
      throw new ForbiddenException('Verified internal service identity is required');
    }
    return true;
  }
}
