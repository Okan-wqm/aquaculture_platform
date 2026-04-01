/**
 * JWT Middleware
 *
 * Decodes and verifies JWT from Authorization header and sets req.user.
 * This runs BEFORE the GraphQL context is created, ensuring req.user
 * is available when Apollo Gateway's willSendRequest forwards headers.
 */

import { Injectable, NestMiddleware, Logger, Inject, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request, Response, NextFunction } from 'express';
import { JwtPayload, AuthenticatedRequest } from '../guards/auth.guard';
import {
  TokenBlacklistStore,
  TOKEN_BLACKLIST_STORE,
} from '../guards/redis-token-blacklist.store';

@Injectable()
export class JwtMiddleware implements NestMiddleware {
  private readonly logger = new Logger(JwtMiddleware.name);

  constructor(
    private readonly jwtService: JwtService,
    @Optional()
    @Inject(TOKEN_BLACKLIST_STORE)
    private readonly tokenBlacklist?: TokenBlacklistStore,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next();
    }

    const token = authHeader.substring(7);

    try {
      // SECURITY: Use JwtService.verifyAsync() with explicit algorithm restriction
      // instead of custom HMAC verification to prevent algorithm confusion attacks
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        algorithms: ['HS256'],
      });

      /**
       * SEC-COMPAT: Legacy tokens without jti cannot be individually revoked
       * but are still cryptographically valid. Log for monitoring and allow
       * during transition period. New tokens always include jti. Once all
       * legacy tokens have expired, this can be tightened to reject them.
       */
      const isProduction = process.env['NODE_ENV'] === 'production';
      if (isProduction && !payload.jti) {
        this.logger.warn(
          `Legacy token without jti detected for user ${payload.sub} — allowing during transition period.`,
        );
      }

      // SECURITY: Check blacklist BEFORE setting req.user
      // This prevents revoked token identity from being forwarded to subgraphs
      if (payload.jti && this.tokenBlacklist) {
        const isBlacklisted = await this.tokenBlacklist.isBlacklisted(payload.jti);
        if (isBlacklisted) {
          this.logger.warn(`Blacklisted token used: ${payload.jti.substring(0, 8)}...`);
          return next();
        }
      }

      // Set user on request - this will be available in GraphQL context
      (req as AuthenticatedRequest).user = payload;

      this.logger.debug(`JWT decoded: user=${payload.sub}, tenant=${payload.tenantId}`);
    } catch (error) {
      // Don't fail the request - let AuthGuard handle unauthorized access
      this.logger.debug(`JWT decode failed in middleware: ${(error as Error).message}`);
    }

    next();
  }
}
