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
import { createHash } from 'crypto';

import type { TenantRequest } from '../types/tenant-request.interface';
import {
  getServiceIdentityHeader,
  parseServiceIdentityKeyring,
  verifyServiceIdentityRequest,
} from '../utils/service-identity.util';
import type { ServiceIdentityKeyringEntry } from '../utils/service-identity.util';
import { SecurityEventService } from '../security/security-event.service';

/**
 * ServiceIdentityGuard validates GraphQL subgraph calls using the canonical
 * v2 service-identity contract. Production uses SERVICE_IDENTITY_KEYRING;
 * legacy single-secret fallback is limited to non-production/test flows.
 */
@Injectable()
export class ServiceIdentityGuard implements CanActivate {
  private readonly logger = new Logger(ServiceIdentityGuard.name);
  private readonly keyring: ServiceIdentityKeyringEntry[];
  private readonly devSecret: string | undefined;
  private warned = false;

  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Optional() private readonly securityEventService?: SecurityEventService,
  ) {
    this.keyring = parseServiceIdentityKeyring(
      this.configService.get<string>('SERVICE_IDENTITY_KEYRING') ?? process.env['SERVICE_IDENTITY_KEYRING'],
    );
    this.devSecret =
      process.env['NODE_ENV'] === 'production'
        ? undefined
        : this.configService.get<string>('SERVICE_IDENTITY_SIGNING_SECRET') ??
          this.configService.get<string>('INTERNAL_SERVICE_SECRET');
  }

  canActivate(context: ExecutionContext): boolean {
    const contextType = context.getType<string>();
    if (contextType !== 'graphql') {
      return true;
    }

    const gqlCtx = GqlExecutionContext.create(context);
    const req = gqlCtx.getContext().req as TenantRequest | undefined;

    if (!req) {
      return true;
    }

    if (req.verifiedIdentity) {
      return true;
    }

    const body = req.body as { query?: string; operationName?: string } | undefined;
    if (this.isIntrospectionQuery(body)) {
      return true;
    }

    if (this.keyring.length === 0 && !this.devSecret) {
      if (process.env['NODE_ENV'] === 'production') {
        throw new Error(
          'SERVICE_IDENTITY_KEYRING is not set. Inter-service authentication is required in production.',
        );
      }
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(
          'SERVICE_IDENTITY_KEYRING is not set — service identity validation is DISABLED for local development.',
        );
      }
      return true;
    }

    const headers = req.headers as Record<string, string | string[] | undefined>;
    const tenantHeader = getServiceIdentityHeader(headers, 'x-tenant-id') ?? '';
    const serviceName = getServiceIdentityHeader(headers, 'x-service-identity') ?? 'unknown';
    const keyId = getServiceIdentityHeader(headers, 'x-service-key-id') ?? '';

    const outcome = verifyServiceIdentityRequest({
      headers,
      observedMethod: req.method ?? 'POST',
      observedPath: this.canonicalisePath(req),
      observedQuery: this.canonicaliseQuery(req),
      observedContentType: getServiceIdentityHeader(headers, 'content-type') ?? '',
      observedAssertionHash: this.assertionHash(headers),
      observedBody: this.serializeBodyForHash(req.body),
      secret: this.devSecret,
      keyLookup: (kid) => this.keyring.find((entry) => entry.kid === kid && entry.status !== 'disabled')?.secret,
      expectedTenantId: tenantHeader,
    });

    if (!outcome.valid) {
      this.logger.warn(
        `Rejected request: ${outcome.reason} from "${serviceName}"` +
          (tenantHeader ? ` (tenant=${tenantHeader})` : ''),
      );
      this.securityEventService?.publishServiceIdentityRejected({
        serviceName,
        reason:
          outcome.reason === 'missing-headers'
            ? 'Missing service identity headers'
            : `Service identity verification failed: ${outcome.reason}`,
      }).catch(() => { /* best-effort */ });
      throw new ForbiddenException(
        outcome.reason === 'missing-headers'
          ? 'Missing service identity headers. Direct access to subgraph services is not allowed.'
          : 'Invalid service identity signature. Request may be forged, expired, or fields tampered with.',
      );
    }

    if (outcome.version === 'v1') {
      this.securityEventService?.publishServiceIdentityRejected({
        serviceName,
        reason: 'service-identity-v1-deprecated-accepted',
      }).catch(() => { /* best-effort */ });
    }

    req.verifiedIdentity = {
      serviceName,
      tenantId: tenantHeader,
      effectiveTenantId: getServiceIdentityHeader(headers, 'x-service-effective-tenant-id') ?? tenantHeader,
      keyId: keyId || (outcome.version === 'v1' ? 'legacy-v1' : 'legacy-v2'),
      audience: getServiceIdentityHeader(headers, 'x-service-audience'),
      nonce: getServiceIdentityHeader(headers, 'x-service-nonce') ?? '',
      version: 'v2',
    };

    return true;
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

  private canonicaliseQuery(req: { originalUrl?: string; url?: string }): string {
    const raw = req.originalUrl ?? req.url ?? '';
    const qIdx = raw.indexOf('?');
    return qIdx === -1 ? '' : raw.slice(qIdx);
  }

  private assertionHash(headers: Record<string, string | string[] | undefined>): string | undefined {
    const assertion = getServiceIdentityHeader(headers, 'x-verified-user-assertion');
    return assertion ? createHash('sha256').update(assertion).digest('hex') : undefined;
  }

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
