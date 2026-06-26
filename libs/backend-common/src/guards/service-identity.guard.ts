import { createHash } from 'crypto';

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

import { serviceIdentityAudienceForService } from '../../../../platform/libs/service-catalog/src/index';
import { SecurityEventService } from '../security/security-event.service';
import type { TenantRequest } from '../types/tenant-request.interface';
import {
  getServiceIdentityHeader,
  parseServiceIdentityKeyring,
  serializeServiceIdentityBodyForHash,
  verifyServiceIdentityRequest,
} from '../utils/service-identity.util';
import type { ServiceIdentityKeyringEntry } from '../utils/service-identity.util';

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
  private readonly expectedAudience: string | undefined;
  private warned = false;

  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Optional() private readonly securityEventService?: SecurityEventService,
    @Optional()
    @Inject('SERVICE_IDENTITY_SERVICE_ID')
    private readonly configuredServiceId?: string,
  ) {
    this.keyring = parseServiceIdentityKeyring(
      this.configService.get<string>('SERVICE_IDENTITY_KEYRING') ??
        process.env['SERVICE_IDENTITY_KEYRING'],
    );
    this.devSecret =
      process.env['NODE_ENV'] === 'production'
        ? undefined
        : (this.configService.get<string>('SERVICE_IDENTITY_SIGNING_SECRET') ??
          this.configService.get<string>('INTERNAL_SERVICE_SECRET'));
    this.expectedAudience = this.resolveExpectedAudience();
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
    if (process.env['NODE_ENV'] !== 'production' && this.isIntrospectionQuery(body)) {
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
      observedBody: serializeServiceIdentityBodyForHash(req),
      secret: this.devSecret,
      keyring: this.keyring,
      allowUnscopedDevKey: process.env['NODE_ENV'] !== 'production',
      expectedTenantId: tenantHeader,
      expectedAudience: this.expectedAudience,
    });

    if (!outcome.valid) {
      this.logger.warn(
        `Rejected request: ${outcome.reason} from "${serviceName}"` +
          (tenantHeader ? ` (tenant=${tenantHeader})` : ''),
      );
      this.securityEventService
        ?.publishServiceIdentityRejected({
          serviceName,
          reason:
            outcome.reason === 'missing-headers'
              ? 'Missing service identity headers'
              : `Service identity verification failed: ${outcome.reason}`,
          // ORPHAN-098: emit the raw, machine-readable cause so operators can
          // tell a forged-signature attack (bad-hmac) apart from a misconfigured
          // caller (caller-not-allowed) — the client message stays generic.
          reasonCode: outcome.reason,
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

    req.verifiedIdentity = {
      serviceName: outcome.serviceName,
      tenantId: tenantHeader,
      effectiveTenantId: outcome.effectiveTenantId,
      keyId: keyId || outcome.keyId,
      audience: outcome.audience,
      nonce: outcome.nonce,
      version: 'v2',
    };

    return true;
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

  private assertionHash(
    headers: Record<string, string | string[] | undefined>,
  ): string | undefined {
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

  private resolveExpectedAudience(): string | undefined {
    const configured =
      this.configService.get<string>('SERVICE_IDENTITY_AUDIENCE') ??
      process.env['SERVICE_IDENTITY_AUDIENCE'];
    if (configured && configured.trim().length > 0) {
      return configured.trim();
    }

    const serviceId =
      this.configuredServiceId ??
      this.configService.get<string>('SERVICE_IDENTITY_SERVICE_ID') ??
      this.configService.get<string>('SERVICE_NAME') ??
      process.env['SERVICE_IDENTITY_SERVICE_ID'] ??
      process.env['SERVICE_NAME'];
    const catalogAudience = serviceId ? serviceIdentityAudienceForService(serviceId) : undefined;
    if (catalogAudience) {
      return catalogAudience;
    }

    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(
        'SERVICE_IDENTITY_AUDIENCE or catalog-backed SERVICE_NAME is required in production. ' +
          'Receiver audience must not be inferred from SERVICE_IDENTITY_KEYRING.',
      );
    }

    return undefined;
  }
}
