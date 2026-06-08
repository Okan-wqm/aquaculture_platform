import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import {
  getServiceIdentityHeader,
  parseServiceIdentityKeyring,
  verifyServiceIdentityRequest,
  type ServiceIdentityKeyringEntry,
} from '@aquaculture/backend-common/utils';
import type { TenantRequest } from '@aquaculture/backend-common/types';
import { eventStoreTenantScopePolicyForService } from '@platform/service-catalog';

const PUBLIC_HEALTH_PATHS = new Set(['/health', '/health/live', '/health/ready']);
const LEGACY_TENANT_SCOPE_POLICY_ENV = 'EVENT_STORE_ALLOWED_SERVICE_TENANT_SCOPES';
const EVENT_STORE_SERVICE_AUDIENCE = 'event-store-service';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

function normalizePath(request: Request): string {
  const raw = request.originalUrl ?? request.url ?? request.path ?? '/';
  const qIdx = raw.indexOf('?');
  return qIdx === -1 ? raw : raw.slice(0, qIdx);
}

function normalizeQuery(request: Request): string {
  const raw = request.originalUrl ?? request.url ?? '';
  const qIdx = raw.indexOf('?');
  return qIdx === -1 ? '' : raw.slice(qIdx);
}

export function assertEventStoreTenantScopePolicy(): void {
  if (process.env['NODE_ENV'] === 'test') {
    return;
  }
  if (process.env[LEGACY_TENANT_SCOPE_POLICY_ENV]) {
    throw new Error(
      `${LEGACY_TENANT_SCOPE_POLICY_ENV} is legacy configuration; use SERVICE_IDENTITY_KEYRING tenantScopePolicy entries`,
    );
  }

  const keyring = parseServiceIdentityKeyring(process.env['SERVICE_IDENTITY_KEYRING']);
  if (keyring.length === 0) {
    throw new Error('SERVICE_IDENTITY_KEYRING is required for event-store-service');
  }

  for (const entry of keyring) {
    if (entry.tenantScopePolicy !== 'all-tenants') {
      continue;
    }
    if (!entry.callers || entry.callers.length === 0) {
      throw new Error(
        `SERVICE_IDENTITY_KEYRING entry ${entry.kid} uses all-tenants without caller binding`,
      );
    }
    for (const caller of entry.callers) {
      if (eventStoreTenantScopePolicyForService(caller) !== 'all-tenants') {
        throw new Error(
          `SERVICE_IDENTITY_KEYRING entry ${entry.kid} grants all-tenants to non-catalog caller ${caller}`,
        );
      }
    }
  }
}

/**
 * Guard that verifies inter-service authentication for event-store-service.
 *
 * SECURITY: The accepted tenant comes only from a verified v2 service identity
 * signature. Raw X-Tenant-Id is an HMAC-bound input, not a controller trust
 * source.
 *
 * Health check endpoints are excluded from authentication.
 */
@Injectable()
export class EventStoreServiceIdentityGuard implements CanActivate {
  private readonly logger = new Logger(EventStoreServiceIdentityGuard.name);
  private readonly keyring: ServiceIdentityKeyringEntry[] = parseServiceIdentityKeyring(
    process.env['SERVICE_IDENTITY_KEYRING'],
  );

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RawBodyRequest & TenantRequest>();
    const observedPath = normalizePath(request);

    // Allow only exact public health endpoints without authentication.
    if (PUBLIC_HEALTH_PATHS.has(observedPath)) {
      return true;
    }

    if (this.keyring.length === 0 && process.env['NODE_ENV'] !== 'test') {
      throw new UnauthorizedException(
        'SERVICE_IDENTITY_KEYRING is required for event-store-service',
      );
    }

    const headers = request.headers as Record<string, string | string[] | undefined>;
    const serviceIdentity = getServiceIdentityHeader(headers, 'x-service-identity') ?? 'unknown';
    const keyId = getServiceIdentityHeader(headers, 'x-service-key-id') ?? '';
    const tenantId = getServiceIdentityHeader(headers, 'x-tenant-id') ?? '';
    const effectiveTenantId =
      getServiceIdentityHeader(headers, 'x-service-effective-tenant-id') ?? tenantId;

    const outcome = verifyServiceIdentityRequest({
      headers,
      observedMethod: request.method ?? 'POST',
      observedPath,
      observedBody: this.rawBodyForHash(request),
      observedQuery: normalizeQuery(request),
      observedContentType: getServiceIdentityHeader(headers, 'content-type') ?? '',
      keyring: this.keyring,
      expectedTenantId: tenantId,
      expectedAudience: EVENT_STORE_SERVICE_AUDIENCE,
    });

    if (!outcome.valid) {
      this.logger.warn(
        `Rejected request: ${outcome.reason} from "${serviceIdentity}"` +
          (tenantId ? ` (tenant=${tenantId})` : ''),
      );
      throw new UnauthorizedException('Event-store requires v2 service identity signatures');
    }

    const keyEntry = this.lookupKeyEntry(keyId, serviceIdentity);
    if (!keyEntry) {
      throw new UnauthorizedException('Event-store requires a valid service identity key');
    }

    this.assertTenantScope(serviceIdentity, tenantId, effectiveTenantId, keyEntry);
    request.tenantId = effectiveTenantId;
    request.verifiedIdentity = {
      serviceName: serviceIdentity,
      tenantId,
      effectiveTenantId,
      keyId,
      audience: EVENT_STORE_SERVICE_AUDIENCE,
      nonce: getServiceIdentityHeader(headers, 'x-service-nonce') ?? '',
      version: 'v2',
    };

    this.logger.log(
      `Service "${serviceIdentity}" accessing tenant "${effectiveTenantId}" via ${request.method} ${request.path}`,
    );
    return true;
  }

  /**
   * Coerce the parsed body back into a byte-stable representation for sha256.
   *
   * WHY: Express + body-parser already JSON.parse'd the body for us; we
   * re-serialize so the hash matches what the SENDER computed before
   * stringifying. Buffer/string passthrough is byte-exact.
   */
  private rawBodyForHash(request: RawBodyRequest): string | Buffer {
    if (request.rawBody) return request.rawBody;
    const body = request.body;
    if (body === undefined || body === null) return '';
    if (typeof body === 'string') return body;
    if (Buffer.isBuffer(body)) return body;
    throw new UnauthorizedException(
      'Raw request body is required for service signature verification',
    );
  }

  private assertTenantScope(
    serviceIdentity: string,
    signedTenantId: string,
    effectiveTenantId: string,
    keyEntry: ServiceIdentityKeyringEntry,
  ): void {
    if (process.env['NODE_ENV'] === 'test') {
      return;
    }
    if (!effectiveTenantId) {
      throw new UnauthorizedException('Tenant ID is required for event-store requests');
    }
    if (!UUID_RE.test(effectiveTenantId)) {
      throw new UnauthorizedException('Tenant ID must be a UUID for event-store requests');
    }

    const keyPolicy = keyEntry.tenantScopePolicy ?? 'tenant-bound';
    if (keyPolicy === 'all-tenants') {
      if (eventStoreTenantScopePolicyForService(serviceIdentity) !== 'all-tenants') {
        this.logger.warn(
          `Rejected all-tenants scope: service "${serviceIdentity}" is not catalog-authorized`,
        );
        throw new UnauthorizedException('Service is not allowed to use all-tenants scope');
      }
      if (signedTenantId && !UUID_RE.test(signedTenantId)) {
        throw new UnauthorizedException('Signed tenant ID must be a UUID for event-store requests');
      }
      return;
    }

    if (!signedTenantId || !UUID_RE.test(signedTenantId)) {
      throw new UnauthorizedException(
        'Signed tenant ID is required for tenant-bound event-store requests',
      );
    }
    if (effectiveTenantId !== signedTenantId) {
      this.logger.warn(
        `Rejected tenant scope: service "${serviceIdentity}" signed tenant "${signedTenantId}" but requested "${effectiveTenantId}"`,
      );
      throw new UnauthorizedException('Service is not allowed to access this tenant');
    }
  }

  private lookupKeyEntry(
    kid: string,
    serviceIdentity: string,
  ): ServiceIdentityKeyringEntry | undefined {
    const entry = this.keyring.find((candidate) => candidate.kid === kid);
    if (!entry || (entry.status ?? 'active') === 'disabled') {
      return undefined;
    }
    if (entry.callers && !entry.callers.includes(serviceIdentity)) {
      return undefined;
    }
    if (entry.audiences && !entry.audiences.includes(EVENT_STORE_SERVICE_AUDIENCE)) {
      return undefined;
    }
    return entry;
  }
}
