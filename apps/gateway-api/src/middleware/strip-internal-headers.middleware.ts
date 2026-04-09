/**
 * Strip Internal Headers Middleware
 *
 * SECURITY: Removes x-user-payload, x-user-id, and x-user-roles headers from
 * incoming requests that do NOT originate from trusted internal services.
 *
 * Internal services authenticate via x-service-identity + x-service-signature
 * (HMAC of identity using INTERNAL_SERVICE_SECRET). If those headers are absent
 * or the signature is invalid, the request is treated as external and the
 * spoofable headers are stripped.
 *
 * This MUST run BEFORE JwtMiddleware so that a forged x-user-payload cannot
 * be picked up by downstream middleware/guards.
 */

import { Injectable, NestMiddleware, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';

const INTERNAL_HEADERS_TO_STRIP = [
  'x-user-payload',
  'x-user-id',
  'x-user-roles',
  'x-tenant-id',
];

@Injectable()
export class StripInternalHeadersMiddleware implements NestMiddleware {
  private readonly logger = new Logger(StripInternalHeadersMiddleware.name);
  private readonly serviceSecret: string | undefined;

  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {
    this.serviceSecret = this.configService.get<string>('INTERNAL_SERVICE_SECRET');
  }

  use(req: Request, _res: Response, next: NextFunction): void {
    if (!this.isValidInternalRequest(req)) {
      for (const header of INTERNAL_HEADERS_TO_STRIP) {
        if (req.headers[header]) {
          this.logger.warn(
            `Stripped spoofed internal header "${header}" from external request (ip=${req.ip ?? 'unknown'}, path=${req.path})`,
          );
          delete req.headers[header];
        }
      }
    }

    next();
  }

  /**
   * Validate that the request is from a trusted internal service.
   * Requires both x-service-identity and x-service-signature headers,
   * and the signature must be a valid HMAC-SHA256 of the identity using
   * the shared INTERNAL_SERVICE_SECRET.
   */
  private isValidInternalRequest(req: Request): boolean {
    if (!this.serviceSecret) {
      return false;
    }

    const identity = req.headers['x-service-identity'];
    const signature = req.headers['x-service-signature'];

    if (typeof identity !== 'string' || typeof signature !== 'string') {
      return false;
    }

    try {
      const expectedSignature = crypto
        .createHmac('sha256', this.serviceSecret)
        .update(identity)
        .digest('hex');

      // Timing-safe comparison
      if (expectedSignature.length !== signature.length) {
        return false;
      }

      return crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(signature),
      );
    } catch {
      return false;
    }
  }
}
