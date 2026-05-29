import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GqlExecutionContext } from '@nestjs/graphql';

import { SecurityEventService } from '../security/security-event.service';
import type { VerifiedServiceIdentity } from '../types/tenant-request.interface';
import { verifyServiceIdentityRequest } from '../utils/service-identity.util';

interface ServiceIdentityRequest {
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  method?: string;
  path?: string;
  originalUrl?: string;
  url?: string;
  verifiedIdentity?: VerifiedServiceIdentity;
}

/**
 * ServiceIdentityGuard validates HMAC-signed internal calls before any
 * farm-service route trusts gateway-forwarded user or tenant context.
 */
@Injectable()
export class ServiceIdentityGuard implements CanActivate {
  private readonly logger = new Logger(ServiceIdentityGuard.name);
  private readonly secret: string | undefined;
  private warned = false;

  // WHY: Explicit @Inject() — design:paramtypes may not survive all build/runtime environments.
  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Optional() private readonly securityEventService?: SecurityEventService,
  ) {
    this.secret = this.configService.get<string>('INTERNAL_SERVICE_SECRET');
  }

  canActivate(context: ExecutionContext): boolean {
    const req = this.getRequest(context);
    if (!req) {
      return true;
    }

    if (this.isProbePath(req)) {
      return true;
    }

    const isProduction = this.isProduction();

    if (!this.secret) {
      if (isProduction) {
        throw new Error(
          'INTERNAL_SERVICE_SECRET is not set. ' +
            'Inter-service authentication is required in production. ' +
            'Set INTERNAL_SERVICE_SECRET to enable service identity validation.',
        );
      }
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(
          'INTERNAL_SERVICE_SECRET is not set — service identity validation is DISABLED. ' +
            'Set INTERNAL_SERVICE_SECRET in production to enforce inter-service authentication.',
        );
      }
      return true;
    }

    if (
      !isProduction &&
      this.isIntrospectionQuery(req.body as { query?: string; operationName?: string } | undefined)
    ) {
      return true;
    }

    const tenantHeader = this.getHeader(req, 'x-tenant-id') ?? '';
    const serviceName = this.getHeader(req, 'x-service-identity') ?? 'unknown';
    const observedBody = this.serializeBodyForHash(req.body);

    const outcome = verifyServiceIdentityRequest({
      headers: req.headers,
      observedMethod: req.method ?? 'POST',
      observedPath: this.canonicalisePath(req),
      observedBody,
      observedUserAssertion: this.getHeader(req, 'x-verified-user-assertion'),
      secret: this.secret,
      expectedTenantId: tenantHeader,
    });

    if (!outcome.valid) {
      this.logger.warn(
        'Rejected request: ' +
          outcome.reason +
          ' from "' +
          serviceName +
          '"' +
          (tenantHeader ? ' (tenant=' + tenantHeader + ')' : ''),
      );
      this.securityEventService
        ?.publishServiceIdentityRejected({
          serviceName,
          reason:
            outcome.reason === 'missing-headers'
              ? 'Missing service identity headers'
              : 'Service identity verification failed: ' + outcome.reason,
        })
        .catch(() => {
          /* best-effort */
        });
      throw new ForbiddenException(
        outcome.reason === 'missing-headers'
          ? 'Missing service identity headers. Direct access to subgraph services is not allowed.'
          : 'Invalid service identity signature. Request may be forged, expired, or fields tampered with.',
      );
    }

    if (outcome.version === 'v1') {
      this.securityEventService
        ?.publishServiceIdentityRejected({
          serviceName,
          reason: 'service-identity-v1-deprecated-observed',
        })
        .catch(() => {
          /* best-effort */
        });

      if (isProduction) {
        throw new ForbiddenException(
          'Deprecated service identity signature version. Production requests must use HMAC v2.',
        );
      }
    }

    req.verifiedIdentity = {
      serviceName,
      tenantId: tenantHeader || undefined,
      signatureVersion: outcome.version,
      verifiedAt: new Date().toISOString(),
    };

    return true;
  }

  private getRequest(context: ExecutionContext): ServiceIdentityRequest | undefined {
    if (context.getType<string>() === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context);
      return gqlCtx.getContext<{ req?: ServiceIdentityRequest }>().req;
    }
    return context.switchToHttp().getRequest<ServiceIdentityRequest>();
  }

  private isProduction(): boolean {
    return (
      this.configService.get<string>('NODE_ENV', process.env['NODE_ENV'] ?? 'development') ===
      'production'
    );
  }

  private isProbePath(req: ServiceIdentityRequest): boolean {
    const path = this.canonicalisePath(req);
    return (
      path === '/metrics' ||
      path === '/health' ||
      path.startsWith('/health/') ||
      path === '/api/metrics' ||
      path === '/api/health' ||
      path.startsWith('/api/health/')
    );
  }

  private getHeader(req: ServiceIdentityRequest, name: string): string | undefined {
    const value = req.headers[name.toLowerCase()] ?? req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }

  /**
   * Coerce the parsed body back into a byte-stable representation for sha256.
   */
  private serializeBodyForHash(body: unknown): string | Buffer {
    if (body === undefined || body === null) return '';
    if (typeof body === 'string') return body;
    if (Buffer.isBuffer(body)) return body;
    return JSON.stringify(body);
  }

  /** Extract the path-only component of the request URL for v2 canonical comparison. */
  private canonicalisePath(req: { path?: string; originalUrl?: string; url?: string }): string {
    const raw = req.originalUrl ?? req.url ?? req.path ?? '/';
    const qIdx = raw.indexOf('?');
    return qIdx === -1 ? raw : raw.slice(0, qIdx);
  }

  /** Detect if a request is a GraphQL introspection query. */
  private isIntrospectionQuery(
    body: { query?: string; operationName?: string } | undefined,
  ): boolean {
    if (!body) {
      return false;
    }

    if (body.operationName === 'IntrospectionQuery') {
      return true;
    }

    const query = body.query;
    if (typeof query === 'string') {
      const trimmed = query.replace(/\s+/g, ' ').trim();
      if (trimmed.includes('__schema') || trimmed.includes('__type')) {
        return true;
      }
      if (trimmed.includes('_service') && trimmed.includes('sdl')) {
        return true;
      }
    }

    return false;
  }
}
