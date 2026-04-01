/**
 * JWT Middleware
 *
 * Decodes and verifies JWT from Authorization header and sets req.user.
 * This runs BEFORE the GraphQL context is created, ensuring req.user
 * is available when Apollo Gateway's willSendRequest forwards headers.
 */

import { Injectable, NestMiddleware, Logger, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request, Response, NextFunction } from 'express';

import { JwtPayload, AuthenticatedRequest } from '../types/index';
import {
  TokenBlacklistStore,
  TOKEN_BLACKLIST_STORE,
} from '../guards/redis-token-blacklist.store';
import { validateAccessTokenCompat } from '../guards/utils/token-validation.util';

@Injectable()
export class JwtMiddleware implements NestMiddleware {
  private readonly logger = new Logger(JwtMiddleware.name);
  private readonly isProduction: boolean;

  constructor(
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Optional()
    @Inject(TOKEN_BLACKLIST_STORE)
    private readonly tokenBlacklist?: TokenBlacklistStore,
  ) {
    this.isProduction = this.configService.get<string>('NODE_ENV', 'development') === 'production';
  }

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

      // SEC-COMPAT: Centralized legacy token validation (type check + jti warning)
      validateAccessTokenCompat(payload, this.logger, this.isProduction);

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
