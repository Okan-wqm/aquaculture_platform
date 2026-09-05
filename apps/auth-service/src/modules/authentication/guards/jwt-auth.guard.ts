import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
  Inject,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { getJwtVerifyOptions, enforceAccessTokenType } from '@aquaculture/backend-common/auth';
import { IS_PUBLIC_KEY } from '@aquaculture/backend-common/decorators';
import {
  ITokenBlacklist,
  IUserTokenRevocation,
  TOKEN_BLACKLIST,
  USER_TOKEN_REVOCATION,
} from '@aquaculture/backend-common/security';
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
    @Inject(TOKEN_BLACKLIST) private readonly tokenBlacklist: ITokenBlacklist,
    @Inject(USER_TOKEN_REVOCATION)
    private readonly userTokenRevocation: IUserTokenRevocation,
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
      // ADR-046: public surfaces get OPTIONAL identity. setupMfa /
      // verifyMfaSetup are @Public so the pre-session enrollment path (the
      // mfa_setup token) can reach them, but those same mutations must keep
      // working for an authenticated session presenting a normal Bearer token.
      // Attach the identity when a VALID access token is present; never reject
      // — a public route stays public.
      await this.attachOptionalIdentity(context);
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
      const payload = (await this.jwtService.verifyAsync(
        token,
        getJwtVerifyOptions(this.configService),
      )) as JwtPayload;

      // SECURITY: Enforce access token type — reject refresh/MFA tokens
      enforceAccessTokenType(payload, this.logger, this.isProduction);

      if (
        typeof payload.jti !== 'string' ||
        payload.jti.trim().length === 0 ||
        typeof payload.sub !== 'string' ||
        payload.sub.trim().length === 0 ||
        typeof payload.iat !== 'number' ||
        !Number.isSafeInteger(payload.iat) ||
        payload.iat <= 0
      ) {
        throw new UnauthorizedException('Invalid or expired token');
      }

      const issuedAt = new Date(payload.iat * 1000);
      const [jtiRevoked, userTokenValid] = await Promise.all([
        this.tokenBlacklist.isBlacklisted(payload.jti),
        this.userTokenRevocation.isTokenValid(payload.sub, issuedAt),
      ]);
      if (jtiRevoked || !userTokenValid) {
        throw new UnauthorizedException('Token has been revoked');
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

  /**
   * ADR-046: best-effort identity attachment for @Public routes.
   *
   * Runs the EXACT verification chain the authenticated path runs (RS256 +
   * issuer/audience via getJwtVerifyOptions, the access-type discriminator,
   * the jti/sub/iat shape assertions, the blacklist and the user-wide
   * revocation epoch) — a token that would not authenticate a protected route
   * never attaches identity here either. The only behavioural difference is
   * the failure mode: a public route swallows the failure and proceeds
   * anonymously instead of throwing 401. This can only ADD identity that was
   * previously discarded; it can never weaken a protected surface.
   *
   * Skips work when identity is already present (gateway-forwarded
   * x-user-payload via TenantContextMiddleware) or when no Bearer token
   * exists.
   */
  private async attachOptionalIdentity(context: ExecutionContext): Promise<void> {
    const request = this.getRequest(context);
    if (request.user) {
      return;
    }
    const token = this.extractToken(request);
    if (!token) {
      return;
    }

    try {
      const payload = (await this.jwtService.verifyAsync(
        token,
        getJwtVerifyOptions(this.configService),
      )) as JwtPayload;

      enforceAccessTokenType(payload, this.logger, this.isProduction);

      if (
        typeof payload.jti !== 'string' ||
        payload.jti.trim().length === 0 ||
        typeof payload.sub !== 'string' ||
        payload.sub.trim().length === 0 ||
        typeof payload.iat !== 'number' ||
        !Number.isSafeInteger(payload.iat) ||
        payload.iat <= 0
      ) {
        return;
      }

      const issuedAt = new Date(payload.iat * 1000);
      const [jtiRevoked, userTokenValid] = await Promise.all([
        this.tokenBlacklist.isBlacklisted(payload.jti),
        this.userTokenRevocation.isTokenValid(payload.sub, issuedAt),
      ]);
      if (jtiRevoked || !userTokenValid) {
        return;
      }

      request.user = payload;
    } catch {
      // Public route: an invalid / expired / revoked / non-access token
      // contributes no identity — the request proceeds anonymously.
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
