import {
  Injectable,
  Inject,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

// getJwtVerifyOptions: centralised JWT verification options (HS256, issuer, audience).
// BEFORE: guard used `import * as jwt from 'jsonwebtoken'` with jwt.verify() —
// synchronous (blocks event loop), no algorithm restriction, no issuer/audience check.
// AFTER: guard uses JwtService.verifyAsync() with getJwtVerifyOptions() — async,
// algorithm-restricted to HS256, issuer + audience enforced at library level.
// jsonwebtoken still imported for error type-checking in the catch block.
import * as jwt from 'jsonwebtoken';
import { JWT_SECURITY_CONSTANTS, getJwtVerifyOptions } from '@aquaculture/backend-common';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * JWT payload structure for admin-api guard.
 *
 * SECURITY (H-08): email is now optional because auth-service no longer
 * embeds PII (email, firstName, lastName) in JWT tokens. Services that
 * need the user's email should fetch it from auth-service using the sub (user ID).
 */
export interface JwtPayload {
  sub: string;
  /** @deprecated Optional -- JWT no longer carries email PII (H-08) */
  email?: string;
  role?: string;
  roles?: string[];
  tenantId?: string;
  iat: number;
  exp: number;
}

export const IS_PUBLIC_KEY = 'isPublic';

// Default roles when no @Roles() decorator is present
const DEFAULT_ADMIN_ROLES = ['SUPER_ADMIN', 'PLATFORM_ADMIN', 'super_admin', 'platform_admin'];

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  private readonly logger = new Logger(PlatformAdminGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {
    // Validate JWT_SECRET length at startup (SEC-L05).
    // getOrThrow() inside getJwtVerifyOptions() handles the missing-secret case.
    const secret = this.configService.get<string>('JWT_SECRET');
    if (secret && secret.length < JWT_SECURITY_CONSTANTS.JWT_SECRET_MIN_LENGTH) {
      throw new Error(
        `JWT_SECRET must be at least ${JWT_SECURITY_CONSTANTS.JWT_SECRET_MIN_LENGTH} characters long for adequate security.`,
      );
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      this.logger.debug(
        `401 Unauthorized: No authorization header provided for ${request.method} ${request.url}`,
      );
      throw new UnauthorizedException('No authorization header provided');
    }

    const [type, token] = authHeader.split(' ');

    if (type !== 'Bearer' || !token) {
      this.logger.debug(
        `401 Unauthorized: Invalid authorization header format for ${request.method} ${request.url}`,
      );
      throw new UnauthorizedException('Invalid authorization header format');
    }

    try {
      // BEFORE: jwt.verify() — synchronous, no algorithm restriction, no iss/aud validation.
      // AFTER: JwtService.verifyAsync() with getJwtVerifyOptions() — async (non-blocking),
      // HS256 algorithm enforced, issuer and audience validated at jsonwebtoken library level.
      const payload = await this.jwtService.verifyAsync<JwtPayload>(
        token,
        getJwtVerifyOptions(this.configService),
      );

      // Normalize user roles - tekil role varsa array'e çevir
      const userRoles = payload.roles || (payload.role ? [payload.role] : []);

      // Attach user to request first (for later use in controllers)
      request.user = {
        id: payload.sub,
        email: payload.email,
        roles: userRoles,
        role: payload.role || userRoles[0],
        tenantId: payload.tenantId,
      };

      // Check for required roles from @Roles() decorator
      // If no decorator, use default admin roles (backward compatible)
      const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) || DEFAULT_ADMIN_ROLES;

      // Case-insensitive role check
      const hasRequiredRole = userRoles.some((userRole) =>
        requiredRoles.some(
          (required) => required.toUpperCase() === userRole.toUpperCase(),
        ),
      );

      if (!hasRequiredRole) {
        // SECURITY: Log user ID only -- do not include email PII in logs (H-14)
        this.logger.warn(
          `Access denied for userId=${payload.sub}: ` +
          `has roles [${userRoles.join(', ')}], requires one of [${requiredRoles.join(', ')}]`,
        );
        throw new ForbiddenException(
          `Access denied. Required roles: ${requiredRoles.join(', ')}`,
        );
      }

      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      if (error instanceof jwt.TokenExpiredError) {
        this.logger.debug(
          `401 Unauthorized: Token expired for ${request.method} ${request.url}`,
        );
        throw new UnauthorizedException('Token has expired');
      }

      if (error instanceof jwt.JsonWebTokenError) {
        this.logger.debug(
          `401 Unauthorized: Invalid JWT token for ${request.method} ${request.url} - ${(error as Error).message}`,
        );
        throw new UnauthorizedException('Invalid token');
      }

      this.logger.error(
        `Authentication error for ${request.method} ${request.url}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw new UnauthorizedException('Authentication failed');
    }
  }
}
