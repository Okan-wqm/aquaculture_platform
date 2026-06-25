import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

import { Role } from './roles.decorator';

/**
 * Current User Type - JWT payload structure
 *
 * Note: tenantId is optional because SUPER_ADMIN users
 * operate at the system level without tenant restriction.
 */
export interface CurrentUserPayload {
  /**
   * User ID (subject)
   */
  sub: string;

  /**
   * User email
   */
  email: string;

  /**
   * Tenant ID - null for SUPER_ADMIN users
   */
  tenantId: string | null;

  /**
   * @deprecated Use `roles` array instead. This field exists for backward
   * compatibility with older JWT payloads and will be removed in a future version.
   * Auth-service should populate only the `roles` array going forward.
   */
  role?: Role | string;

  /**
   * User roles array
   */
  roles: (Role | string)[];

  /**
   * Module codes user has access to
   */
  modules?: string[];

  /**
   * Tenant-level resource permissions (e.g., "tanks:create", "sensors:configure").
   * Populated from the user's tenant role assignment at login time.
   * SUPER_ADMIN and TENANT_ADMIN do not need this -- they have full access.
   */
  resourcePermissions?: string[];

  /**
   * SEC-HIGH-051: farm-service Site ids the user is assigned to (object-level
   * site authorization). The typed SSoT farm resolvers read via @CurrentUser.
   */
  assignedSiteIds?: string[];

  /**
   * SEC-HIGH-052: enabled mobile feature keys the user is entitled to
   * (`auth.mobile_user_settings.allowedFeatures`). Read by MobileFeatureGuard.
   */
  mobileFeatures?: string[];

  /**
   * SSOT-C-13: tenant plan tier ordinal (PLAN_LEVEL) for per-plan quota
   * enforcement in resource-create resolvers. Absent for platform SUPER_ADMIN.
   */
  planLevel?: number;

  /**
   * First name (optional)
   */
  firstName?: string;

  /**
   * Last name (optional)
   */
  lastName?: string;

  /**
   * Token issued at timestamp
   */
  iat?: number;

  /**
   * Token expiration timestamp
   */
  exp?: number;

  /**
   * JWT ID for token blacklisting
   */
  jti?: string;
}

/**
 * Current User Decorator
 * Extracts authenticated user from request context
 */
export const CurrentUser = createParamDecorator(
  (data: keyof CurrentUserPayload | undefined, ctx: ExecutionContext) => {
    const contextType = ctx.getType<string>();
    let user: CurrentUserPayload | undefined;

    if (contextType === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(ctx);
      const request = gqlCtx.getContext().req;
      user = request.user;
    } else {
      const request = ctx.switchToHttp().getRequest();
      user = request.user;
    }

    if (!user) {
      throw new UnauthorizedException('User not found in request context');
    }

    return data ? user[data] : user;
  },
);

/**
 * Optional Current User Decorator
 * Returns undefined if user is not authenticated
 */
export const OptionalCurrentUser = createParamDecorator(
  (data: keyof CurrentUserPayload | undefined, ctx: ExecutionContext) => {
    const contextType = ctx.getType<string>();
    let user: CurrentUserPayload | undefined;

    if (contextType === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(ctx);
      const request = gqlCtx.getContext().req;
      user = request.user;
    } else {
      const request = ctx.switchToHttp().getRequest();
      user = request.user;
    }

    if (!user) {
      return undefined;
    }

    return data ? user[data] : user;
  },
);
