import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { verifyServiceIdentityRequest } from '@aquaculture/backend-common/utils';
import { hashVerifiedUserAssertionHeaders } from '@aquaculture/backend-common/http';

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type TenantScopePolicy = Record<string, string[]>;

/**
 * Guard that verifies inter-service authentication for event-store-service.
 *
 * Supports one authentication method:
 * HMAC-signed service identity: X-Service-Identity + X-Service-Timestamp +
 * X-Service-Signature, tenant-bound by the shared verifier.
 *
 * Health check endpoints are excluded from authentication.
 */
@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(InternalApiKeyGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    // Allow health check endpoints without authentication
    if (request.path.includes('/health')) {
      return true;
    }

    const secret = process.env['INTERNAL_SERVICE_SECRET'];

    if (!secret) {
      this.logger.error('INTERNAL_SERVICE_SECRET is not configured — rejecting request');
      throw new UnauthorizedException('Service authentication required');
    }

    const serviceIdentity = request.headers['x-service-identity'] as string | undefined;
    const serviceTimestamp = request.headers['x-service-timestamp'] as string | undefined;
    const serviceSignature = request.headers['x-service-signature'] as string | undefined;
    const signatureVersion = request.headers['x-service-sig-version'] as string | undefined;

    if (!serviceIdentity || !serviceTimestamp || !serviceSignature || !signatureVersion) {
      throw new UnauthorizedException('Missing service identity headers');
    }
    if (signatureVersion !== 'v2') {
      throw new UnauthorizedException('Service identity v2 is required');
    }

    const tenantHeader = (request.headers['x-tenant-id'] as string | undefined) ?? '';
    if (!tenantHeader || !UUID_V4_REGEX.test(tenantHeader)) {
      throw new UnauthorizedException('Valid tenant ID is required');
    }
    this.assertTenantScope(serviceIdentity, tenantHeader);

    const observedBody = this.serializeBodyForHash((request as Request & { body?: unknown }).body);
    const observedPath = (() => {
      const raw = request.originalUrl ?? request.url ?? request.path ?? '/';
      const qIdx = raw.indexOf('?');
      return qIdx === -1 ? raw : raw.slice(0, qIdx);
    })();

    const outcome = verifyServiceIdentityRequest({
      headers: request.headers as Record<string, string | string[] | undefined>,
      observedMethod: request.method ?? 'POST',
      observedPath,
      observedBody,
      observedAssertionHash: hashVerifiedUserAssertionHeaders(
        request.headers as Record<string, string | string[] | undefined>,
      ),
      secret,
      expectedTenantId: tenantHeader,
    });

    if (!outcome.valid) {
      this.logger.warn(
        `Rejected request: ${outcome.reason} from "${serviceIdentity}"` +
          (tenantHeader ? ` (tenant=${tenantHeader})` : ''),
      );
      throw new UnauthorizedException(
        outcome.reason === 'missing-headers'
          ? 'Missing service identity headers'
          : 'Invalid service identity signature. Request may be forged, expired, or fields tampered with.',
      );
    }

    (request as Request & { tenantId?: string }).tenantId = tenantHeader;

    if (tenantHeader) {
      this.logger.log(
        `Service "${serviceIdentity}" accessing tenant "${tenantHeader}" via ${request.method} ${request.path} (sig=${outcome.version})`,
      );
    }

    return true;
  }

  /**
   * Coerce the parsed body back into a byte-stable representation for sha256.
   *
   * WHY: Express + body-parser already JSON.parse'd the body for us; we
   * re-serialize so the hash matches what the SENDER computed before
   * stringifying. Buffer/string passthrough is byte-exact.
   */
  private serializeBodyForHash(body: unknown): string | Buffer {
    if (body === undefined || body === null) return '';
    if (typeof body === 'string') return body;
    if (Buffer.isBuffer(body)) return body;
    return JSON.stringify(body);
  }

  private assertTenantScope(serviceIdentity: string, tenantId: string): void {
    const policy = this.readTenantScopePolicy();
    const allowed = policy[serviceIdentity] ?? policy['*'];
    if (!allowed || allowed.length === 0) {
      throw new UnauthorizedException(
        `Service "${serviceIdentity}" is not allowed to access event-store tenants`,
      );
    }
    if (!allowed.includes('*') && !allowed.includes(tenantId)) {
      throw new UnauthorizedException(
        `Service "${serviceIdentity}" is not allowed to access tenant "${tenantId}"`,
      );
    }
  }

  private readTenantScopePolicy(): TenantScopePolicy {
    const raw = process.env['EVENT_STORE_ALLOWED_SERVICE_TENANT_SCOPES'];
    if (!raw) {
      if (process.env['NODE_ENV'] === 'production') {
        throw new UnauthorizedException(
          'EVENT_STORE_ALLOWED_SERVICE_TENANT_SCOPES is required in production',
        );
      }
      return { '*': ['*'] };
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('policy must be a JSON object');
      }

      const policy: TenantScopePolicy = {};
      for (const [service, scopes] of Object.entries(parsed)) {
        if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string')) {
          throw new Error(`policy entry for ${service} must be a string array`);
        }
        policy[service] = scopes as string[];
      }
      return policy;
    } catch (error) {
      this.logger.error(
        `Invalid EVENT_STORE_ALLOWED_SERVICE_TENANT_SCOPES: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new UnauthorizedException('Invalid event-store service tenant scope policy');
    }
  }
}
