/**
 * JWT Middleware
 *
 * Decodes and verifies JWT from Authorization header and sets req.user.
 * This runs BEFORE the GraphQL context is created, ensuring req.user
 * is available when Apollo Gateway's willSendRequest forwards headers.
 */

import * as crypto from 'crypto';
import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';
import { JwtPayload, AuthenticatedRequest } from '../guards/auth.guard';

@Injectable()
export class JwtMiddleware implements NestMiddleware {
  private readonly logger = new Logger(JwtMiddleware.name);
  private readonly jwtSecret: string;
  private readonly jwtIssuer: string;

  constructor(private readonly configService: ConfigService) {
    const secret = this.configService.get<string>('JWT_SECRET');
    const devSecret = this.configService.get<string>('DEV_JWT_SECRET');
    const allowDevSecret = this.configService.get<string>('ALLOW_DEV_JWT_SECRET', 'false');

    // Use same secret resolution logic as AuthGuard
    if (secret) {
      this.jwtSecret = secret;
    } else if (allowDevSecret === 'true' && devSecret) {
      this.jwtSecret = devSecret;
    } else {
      this.jwtSecret = '';
      this.logger.warn('JWT_SECRET not configured - JWT middleware will not decode tokens');
    }

    this.jwtIssuer = this.configService.get<string>('JWT_ISSUER', 'aquaculture-platform');
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next();
    }

    const token = authHeader.substring(7);

    if (!this.jwtSecret) {
      return next();
    }

    try {
      const payload = this.decodeAndValidateToken(token);

      // Set user on request - this will be available in GraphQL context
      (req as AuthenticatedRequest).user = payload;

      this.logger.debug(`JWT decoded: user=${payload.sub}, tenant=${payload.tenantId}`);
    } catch (error) {
      // Don't fail the request - let AuthGuard handle unauthorized access
      this.logger.debug(`JWT decode failed in middleware: ${(error as Error).message}`);
    }

    next();
  }

  /**
   * Decode and validate JWT token
   * Uses same logic as AuthGuard for consistency
   */
  private decodeAndValidateToken(token: string): JwtPayload {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid token format');
    }

    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

    // Verify signature
    const data = `${headerB64}.${payloadB64}`;
    const signature = this.base64UrlDecode(signatureB64);
    const expectedSignature = crypto
      .createHmac('sha256', this.jwtSecret)
      .update(data)
      .digest();

    if (!crypto.timingSafeEqual(Buffer.from(signature), expectedSignature)) {
      throw new Error('Invalid signature');
    }

    // Decode payload
    const payloadJson = Buffer.from(this.base64UrlDecode(payloadB64)).toString('utf8');
    const payload = JSON.parse(payloadJson) as JwtPayload;

    // Validate expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      throw new Error('Token expired');
    }

    // Validate issuer
    if (payload.iss && payload.iss !== this.jwtIssuer) {
      throw new Error('Invalid issuer');
    }

    return payload;
  }

  /**
   * Base64 URL decode
   */
  private base64UrlDecode(str: string): Buffer {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) {
      str += '=';
    }
    return Buffer.from(str, 'base64');
  }
}
