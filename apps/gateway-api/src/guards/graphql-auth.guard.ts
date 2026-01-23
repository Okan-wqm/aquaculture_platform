import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

/**
 * Metadata key for public routes
 */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Public decorator - marks a route as publicly accessible
 */
export const Public = (): ReturnType<typeof SetMetadata> => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * JWT Payload interface
 */
export interface JwtPayload {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
  permissions?: string[];
  iat: number;
  exp: number;
}

/**
 * Authenticated request with user info
 */
interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
  userId?: string;
  tenantId?: string;
}

/**
 * GraphQL context with request
 */
interface GqlContext {
  req?: AuthenticatedRequest;
}

/**
 * GraphQL Auth Guard
 * Validates JWT tokens for GraphQL requests
 * Supports public routes via @Public() decorator
 */
@Injectable()
export class GraphQLAuthGuard implements CanActivate {
  private readonly logger = new Logger(GraphQLAuthGuard.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // Get GraphQL context
    const ctx = GqlExecutionContext.create(context);
    const gqlContext = ctx.getContext<GqlContext>();
    const request = gqlContext.req;

    if (!request) {
      // REST endpoint
      const httpContext = context.switchToHttp();
      const httpRequest = httpContext.getRequest<AuthenticatedRequest>();
      return this.validateRequest(httpRequest);
    }

    return this.validateRequest(request);
  }

  private async validateRequest(request: AuthenticatedRequest): Promise<boolean> {
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('Missing authentication token');
    }

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      // Attach user info to request
      request.user = payload;
      request.userId = payload.sub;
      request.tenantId = payload.tenantId;

      this.logger.debug(
        `User ${payload.sub} authenticated for tenant ${payload.tenantId}`,
      );

      return true;
    } catch (error) {
      this.logger.warn(`JWT validation failed: ${(error as Error).message}`);
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private extractToken(request: AuthenticatedRequest): string | null {
    const authHeader = request.headers?.authorization;

    if (!authHeader) {
      return null;
    }

    const parts = authHeader.split(' ');
    const type = parts[0];
    const token = parts[1];

    if (type !== 'Bearer' || !token) {
      return null;
    }

    return token;
  }
}
