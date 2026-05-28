/**
 * Strip Internal Headers Middleware — canonical, cross-service.
 *
 * Removes gateway-forwarded user/tenant headers unless the request carries a
 * verified internal service identity. This middleware must run before any
 * middleware that parses x-user-payload or tenant context.
 */

import { createHmac, timingSafeEqual } from 'crypto';

import { Injectable, NestMiddleware, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';

import type { VerifiedServiceIdentity } from '../types/tenant-request.interface';
import { verifyServiceIdentityRequest } from '../utils/service-identity.util';

const INTERNAL_HEADERS_TO_STRIP = [
  'x-user-payload',
  'x-user-id',
  'x-user-roles',
  'x-tenant-id',
] as const;

interface InternalHeaderRequest extends Request {
  verifiedIdentity?: VerifiedServiceIdentity;
}

@Injectable()
export class StripInternalHeadersMiddleware implements NestMiddleware {
  private readonly logger = new Logger(StripInternalHeadersMiddleware.name);
  private readonly serviceSecret: string | undefined;

  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {
    this.serviceSecret = this.configService.get<string>('INTERNAL_SERVICE_SECRET');
  }

  use(req: InternalHeaderRequest, _res: Response, next: NextFunction): void {
    const identity = this.verifyInternalRequest(req);
    if (identity) {
      req.verifiedIdentity = identity;
      next();
      return;
    }

    for (const header of INTERNAL_HEADERS_TO_STRIP) {
      if (req.headers[header]) {
        this.logger.warn(
          'Stripped spoofed internal header "' +
            header +
            '" from external request ' +
            '(ip=' +
            (req.ip ?? 'unknown') +
            ', path=' +
            req.path +
            ')',
        );
        Reflect.deleteProperty(req.headers, header);
      }
    }

    next();
  }

  private verifyInternalRequest(req: Request): VerifiedServiceIdentity | null {
    if (!this.serviceSecret) return null;

    const serviceName = this.getHeader(req, 'x-service-identity');
    const signature = this.getHeader(req, 'x-service-signature');
    if (!serviceName || !signature) return null;

    const tenantId = this.getHeader(req, 'x-tenant-id') ?? '';
    const sigVersion = this.getHeader(req, 'x-service-sig-version');
    const timestamp = this.getHeader(req, 'x-service-timestamp');

    if (sigVersion === 'v2' || timestamp) {
      const outcome = verifyServiceIdentityRequest({
        headers: req.headers,
        observedMethod: req.method ?? 'GET',
        observedPath: this.canonicalisePath(req),
        observedBody: this.serializeBodyForHash(req.body),
        secret: this.serviceSecret,
        expectedTenantId: tenantId,
      });

      if (!outcome.valid) return null;
      if (outcome.version === 'v1' && this.isProduction()) return null;

      return {
        serviceName,
        tenantId: tenantId || undefined,
        signatureVersion: outcome.version,
        verifiedAt: new Date().toISOString(),
      };
    }

    if (this.isProduction()) return null;

    try {
      const expected = createHmac('sha256', this.serviceSecret).update(serviceName).digest('hex');
      if (expected.length !== signature.length) return null;
      if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
      return {
        serviceName,
        tenantId: tenantId || undefined,
        signatureVersion: 'v1',
        verifiedAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  private isProduction(): boolean {
    return (
      this.configService.get<string>('NODE_ENV', process.env['NODE_ENV'] ?? 'development') ===
      'production'
    );
  }

  private getHeader(req: Request, name: string): string | undefined {
    const value = req.headers[name.toLowerCase()] ?? req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }

  private serializeBodyForHash(body: unknown): string | Buffer {
    if (body === undefined || body === null) return '';
    if (typeof body === 'string') return body;
    if (Buffer.isBuffer(body)) return body;
    return JSON.stringify(body);
  }

  private canonicalisePath(req: { path?: string; originalUrl?: string; url?: string }): string {
    const raw = req.originalUrl ?? req.url ?? req.path ?? '/';
    const qIdx = raw.indexOf('?');
    return qIdx === -1 ? raw : raw.slice(0, qIdx);
  }
}
