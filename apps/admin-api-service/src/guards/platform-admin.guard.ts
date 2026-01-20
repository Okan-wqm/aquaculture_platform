import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { ROLES_KEY } from '../decorators/roles.decorator';

export interface JwtPayload {
  sub: string;
  email: string;
  role?: string; // Tekil role (auth-service'den)
  roles?: string[]; // Array roles (alternatif)
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
  private readonly jwtSecret: string;

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {
    this.jwtSecret = this.configService.get<string>('JWT_SECRET', 'default-secret-change-in-production');
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
      throw new UnauthorizedException('No authorization header provided');
    }

    const [type, token] = authHeader.split(' ');

    if (type !== 'Bearer' || !token) {
      throw new UnauthorizedException('Invalid authorization header format');
    }

    try {
      const payload = jwt.verify(token, this.jwtSecret) as JwtPayload;

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
        this.logger.warn(
          `Access denied for user ${payload.sub} (${payload.email}): ` +
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
        throw new UnauthorizedException('Token has expired');
      }

      if (error instanceof jwt.JsonWebTokenError) {
        throw new UnauthorizedException('Invalid token');
      }

      this.logger.error(
        `Authentication error: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw new UnauthorizedException('Authentication failed');
    }
  }
}
