/**
 * JWT Middleware
 *
 * Decodes and verifies JWT from Authorization header and sets req.user.
 * This runs BEFORE the GraphQL context is created, ensuring req.user
 * is available when Apollo Gateway's willSendRequest forwards headers.
 */

import {
  enforceAccessTokenType,
  enforceTokenNotRevoked,
  getJwtVerifyOptions,
} from '@aquaculture/backend-common/auth';
import {
  ITokenRevocationReader,
  TOKEN_REVOCATION_READER,
} from '@aquaculture/backend-common/security';
import { Inject, Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { NextFunction, Request, Response } from 'express';

import { AuthenticatedRequest, JwtPayload } from '../types/index';

@Injectable()
export class JwtMiddleware implements NestMiddleware {
  private readonly logger = new Logger(JwtMiddleware.name);
  private readonly isProduction: boolean;

  constructor(
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(TOKEN_REVOCATION_READER)
    private readonly tokenRevocationReader: ITokenRevocationReader,
  ) {
    this.isProduction = this.configService.get<string>('NODE_ENV', 'development') === 'production';
  }

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const request = req as AuthenticatedRequest;
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next();
    }

    const token = authHeader.substring(7);

    try {
      // SECURITY: Use getJwtVerifyOptions() to enforce algorithm, issuer, and audience
      // at library level — prevents algorithm confusion and rejects tokens that
      // omit the required issuer/audience claims.
      const payload = await this.jwtService.verifyAsync<JwtPayload>(
        token,
        getJwtVerifyOptions(this.configService),
      );

      // SEC-COMPAT: Centralized legacy token validation (type check + jti warning)
      enforceAccessTokenType(payload, this.logger, this.isProduction);

      let hasValidRevocationState = false;
      if (
        typeof payload.jti === 'string' &&
        payload.jti.trim().length > 0 &&
        typeof payload.sub === 'string' &&
        payload.sub.trim().length > 0 &&
        Number.isSafeInteger(payload.iat) &&
        payload.iat > 0
      ) {
        try {
          await enforceTokenNotRevoked(payload, this.tokenRevocationReader, this.logger);
          hasValidRevocationState = true;
        } catch (error) {
          this.logger.error(
            JSON.stringify({
              event: 'gateway_composite_token_validity_check_failed',
              errorType: error instanceof Error ? error.name : 'UnknownError',
            }),
          );
        }
      }

      // SECURITY: Composite validity is mandatory before req.user is populated.
      // This single read covers the per-JTI marker and the user invalidation epoch.
      if (!hasValidRevocationState) {
        request.user = undefined;
        request.jwtAuthenticationFailure = 'TOKEN_REVOKED';
        this.logger.warn(JSON.stringify({ event: 'gateway_jwt_revoked' }));
        next();
        return;
      }

      // Set user on request - this will be available in GraphQL context
      request.user = payload;
      request.jwtAuthenticationFailure = undefined;

      this.logger.debug(JSON.stringify({ event: 'gateway_jwt_authenticated' }));
    } catch (error) {
      // Don't fail the request - let AuthGuard handle unauthorized access
      request.user = undefined;
      request.jwtAuthenticationFailure = 'INVALID_TOKEN';
      this.logger.debug(
        JSON.stringify({
          event: 'gateway_jwt_verification_failed',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
    }

    next();
  }
}
