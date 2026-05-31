import { Injectable, Logger, NestMiddleware, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';
import {
  VERIFIED_USER_ASSERTION_HEADER,
  VERIFIED_USER_ASSERTION_SIGNATURE_HEADER,
  verifyVerifiedUserAssertionHeaders,
} from '../http/gateway-verified-user-assertion';

const LEGACY_USER_CONTEXT_HEADERS = [
  'x-user-payload',
  'x-user-id',
  'x-user-roles',
] as const;

@Injectable()
export class VerifiedUserAssertionMiddleware implements NestMiddleware {
  private readonly logger = new Logger(VerifiedUserAssertionMiddleware.name);
  private readonly serviceSecret?: string;
  private warnedDevMissingSecret = false;

  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
  ) {
    this.serviceSecret = this.configService.get<string>('INTERNAL_SERVICE_SECRET');
  }

  use(req: Request, res: Response, next: NextFunction): void {
    if (!this.serviceSecret) {
      if (process.env['NODE_ENV'] === 'production') {
        res.status(500).json({
          code: 'INTERNAL_SERVICE_SECRET_REQUIRED',
          message: 'Verified user assertion validation is required in production.',
        });
        return;
      }
      if (!this.warnedDevMissingSecret) {
        this.warnedDevMissingSecret = true;
        this.logger.warn(
          'INTERNAL_SERVICE_SECRET is not set — verified user assertions are not enforced in this development process.',
        );
      }
      next();
      return;
    }

    const hasAssertion =
      this.hasHeader(req, VERIFIED_USER_ASSERTION_HEADER) ||
      this.hasHeader(req, VERIFIED_USER_ASSERTION_SIGNATURE_HEADER);

    if (!hasAssertion) {
      if (this.hasAuthorization(req) || this.hasLegacyUserContext(req)) {
        res.status(401).json({
          code: 'VERIFIED_USER_ASSERTION_REQUIRED',
          message: 'Authenticated internal requests must carry a verified user assertion.',
        });
        return;
      }
      next();
      return;
    }

    const outcome = verifyVerifiedUserAssertionHeaders({
      headers: req.headers as Record<string, string | string[] | undefined>,
      secret: this.serviceSecret,
    });

    if (!outcome.valid) {
      res.status(401).json({
        code: 'INVALID_VERIFIED_USER_ASSERTION',
        message: `Verified user assertion rejected: ${outcome.reason}.`,
      });
      return;
    }

    const tenantId = outcome.assertion.user.tenantId;
    const tenantHeader = this.getHeader(req, 'x-tenant-id');
    if (tenantId && tenantHeader !== tenantId) {
      res.status(401).json({
        code: 'VERIFIED_USER_ASSERTION_TENANT_MISMATCH',
        message: 'Verified user assertion tenant does not match the signed tenant header.',
      });
      return;
    }

    const userPayload = JSON.stringify(outcome.assertion.user);
    req.headers['x-user-payload'] = userPayload;
    req.headers['x-user-id'] = outcome.assertion.user.sub;
    req.headers['x-user-roles'] = JSON.stringify(outcome.assertion.user.roles);

    next();
  }

  private hasAuthorization(req: Request): boolean {
    const value = this.getHeader(req, 'authorization');
    return typeof value === 'string' && value.trim().length > 0;
  }

  private hasLegacyUserContext(req: Request): boolean {
    return LEGACY_USER_CONTEXT_HEADERS.some((header) => this.hasHeader(req, header));
  }

  private hasHeader(req: Request, name: string): boolean {
    return this.getHeader(req, name) !== undefined;
  }

  private getHeader(req: Request, name: string): string | undefined {
    const lower = name.toLowerCase();
    const value = req.headers[lower] ?? req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }
}
