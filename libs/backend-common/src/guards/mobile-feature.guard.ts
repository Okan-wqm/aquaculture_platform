import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';

import { MOBILE_FEATURE_KEY } from '../decorators/requires-mobile-feature.decorator';
import { Role, roleHasPermission } from '../decorators/roles.decorator';

/**
 * User shape the guard reads from the request — the union of the direct-JWT
 * payload and the gateway verified-user assertion (`req.user`). `mobileFeatures`
 * is the enabled-feature-keys claim minted by TokenService and threaded through
 * the assertion chain.
 */
interface MobileFeatureUser {
  sub?: string;
  roles?: (string | Role)[];
  role?: string | Role;
  mobileFeatures?: string[];
}

/** The minimal request shape the guard reads — `req.user` set by the auth guard. */
interface RequestWithUser {
  user?: MobileFeatureUser;
}

/**
 * MobileFeatureGuard (SEC-HIGH-052)
 *
 * WHY: enforces the per-user mobile entitlement
 * (`auth.mobile_user_settings.allowedFeatures`, the SSoT) server-side for any
 * mutation annotated with {@link RequiresMobileFeature}. Without it the feature
 * flags were client-only and a crafted GraphQL request bypassed them.
 *
 * WHAT: reads the required feature from route metadata; FAILS CLOSED —
 *   1. no metadata on the route => allow (no-op on un-annotated routes);
 *   2. SUPER_ADMIN / TENANT_ADMIN bypass via the canonical hierarchy
 *      (`roleHasPermission(role, TENANT_ADMIN)`) — admins are not feature-gated;
 *   3. a MISSING `mobileFeatures` claim for a non-admin => deny (a missing claim
 *      is never an implicit allow);
 *   4. the feature not present in `mobileFeatures` => deny;
 *   5. otherwise allow.
 *
 * ORDERING: it reads `req.user` already populated by the upstream auth guard;
 * the admin bypass is INSIDE this guard via `roleHasPermission`, so correctness
 * does not depend on RolesGuard ordering. ONE guard, the SSoT.
 */
@Injectable()
export class MobileFeatureGuard implements CanActivate {
  // WHY: Explicit @Inject() — design:paramtypes may not survive all build/runtime environments.
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredFeature = this.reflector.getAllAndOverride<string | undefined>(
      MOBILE_FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );

    // (1) un-annotated route — this guard is a no-op.
    if (!requiredFeature) {
      return true;
    }

    const user = this.getUser(context);

    // SECURITY: generic message — never disclose the feature or role detail.
    const accessDenied = 'Access denied';

    if (!user) {
      throw new ForbiddenException(accessDenied);
    }

    // (2) admin bypass via the canonical hierarchy (SUPER_ADMIN / TENANT_ADMIN).
    const roles = this.extractRoles(user);
    const isAdminOrHigher = roles.some((role) =>
      roleHasPermission(role, Role.TENANT_ADMIN),
    );
    if (isAdminOrHigher) {
      return true;
    }

    // (3) fail-closed: a missing claim for a non-admin is never an implicit allow.
    const mobileFeatures = user.mobileFeatures;
    if (!Array.isArray(mobileFeatures)) {
      throw new ForbiddenException(accessDenied);
    }

    // (4) the entitlement must explicitly include the required feature.
    if (!mobileFeatures.includes(requiredFeature)) {
      throw new ForbiddenException(accessDenied);
    }

    // (5) allow.
    return true;
  }

  /**
   * Resolve the canonical Role values from the request user, tolerating both
   * the `roles` array and the legacy single `role` field (mirrors RolesGuard).
   */
  private extractRoles(user: MobileFeatureUser): Role[] {
    const raw: (string | Role)[] = [];
    if (Array.isArray(user.roles)) {
      raw.push(...user.roles);
    }
    if (user.role) {
      raw.push(user.role);
    }
    return raw
      .map((r) => String(r).toUpperCase() as Role)
      .filter((r) => Object.values(Role).includes(r));
  }

  /**
   * Read `req.user` from either a GraphQL or HTTP execution context.
   */
  private getUser(context: ExecutionContext): MobileFeatureUser | undefined {
    const request =
      context.getType<string>() === 'graphql'
        ? GqlExecutionContext.create(context).getContext<{ req?: RequestWithUser }>().req
        : context.switchToHttp().getRequest<RequestWithUser>();
    return request?.user;
  }
}
