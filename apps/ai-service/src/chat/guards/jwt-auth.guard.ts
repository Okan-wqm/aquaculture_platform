/**
 * JWT Authentication Guard for AI Service REST Controllers
 *
 * SECURITY (H-07): This guard ensures that REST endpoints (e.g., ChatController)
 * require a valid, gateway-verified user context before processing requests.
 *
 * The ai-service uses TenantGuard and RolesGuard as global APP_GUARDs, but these
 * guards operate on the assumption that req.user is already populated (by the
 * gateway's JWT verification and x-user-payload header forwarding). For GraphQL
 * resolvers, the user context is parsed in the GraphQL context factory. However,
 * REST controllers need an explicit guard to verify the user payload exists.
 *
 * This guard checks for the presence of req.user (populated by UserContextMiddleware
 * from the x-user-payload header forwarded by the gateway). It supports the @Public()
 * decorator for endpoints that should be accessible without authentication (e.g., health).
 */

import {
  Injectable,
  Inject,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/** Metadata key used by @Public() decorator from backend-common */
const IS_PUBLIC_KEY = 'isPublic';

/**
 * Minimal user payload shape expected from the gateway's x-user-payload header
 */
interface UserPayload {
  sub: string;
  tenantId?: string;
  roles?: string[];
}

/**
 * Request with optional user property populated by UserContextMiddleware
 */
interface AuthenticatedRequest {
  user?: UserPayload;
  headers: Record<string, string | string[] | undefined>;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  // WHY: Explicit @Inject() — design:paramtypes may not survive all build/runtime environments.
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  /**
   * Validates that the request carries a verified user context.
   *
   * @param context - The NestJS execution context
   * @returns true if the request is authenticated or the endpoint is public
   * @throws UnauthorizedException if no valid user context is found
   */
  canActivate(context: ExecutionContext): boolean {
    // Allow endpoints decorated with @Public() to bypass authentication
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request?.user;

    if (!user || !user.sub) {
      throw new UnauthorizedException(
        'Authentication required. Ensure the request includes a valid JWT token.',
      );
    }

    return true;
  }
}
