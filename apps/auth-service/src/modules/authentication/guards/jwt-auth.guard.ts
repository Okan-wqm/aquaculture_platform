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
import { IS_PUBLIC_KEY, ITokenBlacklist, TOKEN_BLACKLIST } from '@aquaculture/backend-common';
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
  private readonly expectedAudience: string;

  // IMPORTANT: Explicit @Inject() for webpack compatibility (design:paramtypes strip).
  constructor(
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Optional() @Inject(TOKEN_BLACKLIST) private readonly tokenBlacklist?: ITokenBlacklist,
  ) {
    this.expectedAudience = this.configService.get<string>('JWT_AUDIENCE', 'aquaculture-platform');
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
      /** SEC-M14: Explicitly restrict JWT algorithm to HS256 to prevent algorithm confusion attacks.
       *  Without this, an attacker could forge tokens using RS256 with the public key as HMAC secret.
       *  Also verifies JWT audience to prevent cross-service token replay. */
      const payload = await this.jwtService.verifyAsync(token, {
        algorithms: ['HS256'],
        audience: this.expectedAudience,
      }) as JwtPayload;

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
