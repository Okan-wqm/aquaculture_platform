import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
  Inject,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { getJwtVerifyOptions, enforceAccessTokenType } from '@aquaculture/backend-common/auth';
import { IS_PUBLIC_KEY } from '@aquaculture/backend-common/decorators';
import { ITokenBlacklist, TOKEN_BLACKLIST } from '@aquaculture/backend-common/security';
import { Logger } from '@nestjs/common';
import { Request } from 'express';

import { JwtPayload } from '../services/token.service';

/**
 * Extended request with user payload
 */
interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

/**
 * GraphQL context with request
 */
interface GqlContext {
  req: AuthenticatedRequest;
}

@Injectable()
export class JwtAuthGuard {
  private readonly logger = new Logger(JwtAuthGuard.name);
  private readonly isProduction: boolean;

  constructor(
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Optional() @Inject(TOKEN_BLACKLIST) private readonly tokenBlacklist?: ITokenBlacklist,
  ) {
    this.isProduction = this.configService.get<string>('NODE_ENV') === 'production';
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if endpoint is public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = this.getRequest(context);
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('No authentication token provided');
    }

    try {
      // SECURITY: Use platform-standard RS256 verification (getJwtVerifyOptions).
      // WHY: Auth-service previously used HS256 here while the token issuer had
      // already migrated to RS256 signing. This caused ALL tenant-admin queries
      // to fail with "Invalid or expired token" because RS256 tokens cannot pass
      // HS256 verification. Now uses the same verification path as the gateway.
      const payload = await this.jwtService.verifyAsync(
        token,
        getJwtVerifyOptions(this.configService),
      ) as JwtPayload;

      // SECURITY: Enforce access token type — reject refresh/MFA tokens
      enforceAccessTokenType(payload, this.logger, this.isProduction);

      // SECURITY: Check token blacklist using composite method
      // Validates both per-JTI blacklist and per-user bulk invalidation
      if (this.tokenBlacklist && payload.jti && payload.sub && payload.iat) {
        const tokenIssuedAt = new Date(payload.iat * 1000);
        const isValid = await this.tokenBlacklist.isValidToken(
          payload.jti,
          payload.sub,
          tokenIssuedAt,
        );
        if (!isValid) {
          throw new UnauthorizedException('Token has been revoked');
        }
      }

      request.user = payload;
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private getRequest(context: ExecutionContext): AuthenticatedRequest {
    const contextType = context.getType<string>();

    if (contextType === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context);
      const ctx = gqlCtx.getContext<GqlContext>();
      return ctx.req;
    }

    return context.switchToHttp().getRequest<AuthenticatedRequest>();
  }

  private extractToken(request: AuthenticatedRequest): string | null {
    const authHeader = request.headers?.authorization;
    if (!authHeader) return null;

    const [type, token] = authHeader.split(' ');
    return type === 'Bearer' && token ? token : null;
  }
}
