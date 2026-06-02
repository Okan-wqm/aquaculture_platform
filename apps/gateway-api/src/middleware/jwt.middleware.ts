/**
 * JWT Middleware
 *
 * Decodes and verifies JWT from Authorization header and sets req.user.
 * This runs BEFORE the GraphQL context is created, ensuring req.user
 * is available when Apollo Gateway's willSendRequest forwards headers.
 */

import { Injectable, NestMiddleware, Logger, Inject } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

import { AuthenticatedRequest } from '../types/index';
import { GatewayTokenVerifierService } from '../guards/gateway-token-verifier.service';

@Injectable()
export class JwtMiddleware implements NestMiddleware {
  private readonly logger = new Logger(JwtMiddleware.name);

  constructor(
    @Inject(GatewayTokenVerifierService)
    private readonly tokenVerifier: GatewayTokenVerifierService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next();
    }

    const token = authHeader.substring(7);

    try {
      const payload = await this.tokenVerifier.verifyAccessToken(token, {
        context: 'JwtMiddleware',
      });
      if (!payload) {
        return next();
      }

      // Set user on request - this will be available in GraphQL context
      const authenticatedRequest = req as AuthenticatedRequest;
      authenticatedRequest.user = payload;
      authenticatedRequest.jwtVerified = true;
      (
        authenticatedRequest as AuthenticatedRequest & {
          gatewayVerifiedJwtPayload?: typeof payload;
        }
      ).gatewayVerifiedJwtPayload = payload;

      this.logger.debug(`JWT decoded: user=${payload.sub}, tenant=${payload.tenantId}`);
    } catch (error) {
      // Don't fail the request - let AuthGuard handle unauthorized access
      this.logger.debug(`JWT decode failed in middleware: ${(error as Error).message}`);
    }

    next();
  }
}
