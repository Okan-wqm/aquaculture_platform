/**
 * Strip Internal Headers Middleware — canonical, cross-service.
 *
 * # Why this middleware exists
 *
 * Internal services trust four request headers to carry user/tenant
 * context across hops:
 *
 *   - x-user-payload  (full decoded JWT payload, JSON-stringified)
 *   - x-user-id
 *   - x-user-roles
 *   - x-tenant-id
 *
 * If any of these arrives on an EXTERNAL request (one not signed by a
 * trusted internal service), it is a forgery attempt — an attacker who
 * controls a Docker-network host could otherwise craft
 * `x-user-payload: {"role":"SUPER_ADMIN","tenantId":null}` against any
 * `@Public()` endpoint and gain SUPER_ADMIN context. SEC-CRITICAL-002 +
 * SECREV-CRITICAL-002 captured the exact gap on auth-service +
 * billing-service AppModules — neither registered the middleware, so
 * forged headers passed through untouched to UserContextMiddleware which
 * trusted them.
 *
 * # What it does
 *
 *   1. Reads x-service-identity + x-service-signature.
 *   2. Verifies the signature against the v2 service-identity keyring.
 *   3. If signature is valid → request is from a trusted internal source,
 *      headers are forwarded as-is.
 *   4. If signature is missing OR invalid → strips the four spoofable
 *      headers from `req.headers` so downstream middleware/guards see
 *      no forged context.
 *
 * # Why this middleware lives in backend-common
 *
 * Pre-fix the implementation lived in apps/gateway-api/. The audit
 * captured 14+ other services that needed identical protection but
 * could not reuse the gateway-local class without a `apps/`-cross-import
 * (forbidden by Nx project boundaries). Promoting it to backend-common
 * lets every service mount it via the bootstrap helper or its own
 * MiddlewareConsumer registration.
 *
 * # MUST run BEFORE auth middleware
 *
 * Order matters: a forged x-user-payload header would be picked up by
 * UserContextMiddleware / JwtMiddleware before this middleware fires
 * if registered later. Each service's AppModule MUST mount this
 * middleware as the FIRST `apply()` call against its global routes.
 *
 * Closes: docs/reviews/auth-security-expert/2026-04-28-core-platform-review.md#SEC-CRITICAL-002
 * Closes: docs/reviews/security-reviewer/2026-04-28-core-platform-review.md#SECREV-CRITICAL-002
 */

import { createHash } from 'crypto';

import { Injectable, NestMiddleware, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IMPERSONATION_CREDENTIAL_HEADER,
  IMPERSONATION_SESSION_HEADER,
} from '@aquaculture/shared-contracts';
import type { Request, Response, NextFunction } from 'express';

import { serviceIdentityAudiencesForService } from '../../../../platform/libs/service-catalog/src/index';
import type { TenantRequest, VerifiedServiceIdentity } from '../types/tenant-request.interface';
import {
  getServiceIdentityHeader,
  parseServiceIdentityKeyring,
  serializeServiceIdentityBodyForHash,
  verifyServiceIdentityRequest,
} from '../utils/service-identity.util';
import type { ServiceIdentityKeyringEntry } from '../utils/service-identity.util';

/**
 * The four request headers we treat as INTERNAL trust anchors. Any of
 * these on an external (un-signed) request is a forgery attempt and is
 * stripped. Update this list ONLY in concert with the matching guard /
 * middleware that reads each header.
 */
const INTERNAL_HEADERS_TO_STRIP = [
  'x-user-payload',
  'x-user-id',
  'x-user-roles',
  'x-tenant-id',
  'x-act-as-tenant',
  IMPERSONATION_CREDENTIAL_HEADER,
  IMPERSONATION_SESSION_HEADER,
  'x-verified-user-assertion',
  // ORPHAN-MEDIUM-319: gateway-minted client network identity. Trusted by
  // resolveClientNetworkContext ONLY when the request carries a verified
  // gateway service identity — stripped here so an unsigned sender can
  // never plant a forged forensic IP/UA on audit rows.
  'x-client-ip',
  'x-client-user-agent',
] as const;

@Injectable()
export class StripInternalHeadersMiddleware implements NestMiddleware {
  private readonly logger = new Logger(StripInternalHeadersMiddleware.name);
  private readonly serviceSecret: string | undefined;
  private readonly keyring: ServiceIdentityKeyringEntry[];
  private readonly expectedAudiences: readonly string[];

  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {
    this.keyring = parseServiceIdentityKeyring(
      this.configService.get<string>('SERVICE_IDENTITY_KEYRING') ??
        process.env['SERVICE_IDENTITY_KEYRING'],
    );
    this.serviceSecret =
      process.env['NODE_ENV'] === 'production'
        ? undefined
        : (this.configService.get<string>('SERVICE_IDENTITY_SIGNING_SECRET') ??
          this.configService.get<string>('INTERNAL_SERVICE_SECRET'));
    this.expectedAudiences = this.resolveExpectedAudiences();
  }

  use(req: TenantRequest, _res: Response, next: NextFunction): void {
    const verifiedIdentity = this.verifyInternalRequest(req);
    if (verifiedIdentity) {
      req.verifiedIdentity = verifiedIdentity;
    } else {
      for (const header of INTERNAL_HEADERS_TO_STRIP) {
        if (req.headers[header]) {
          this.logger.warn(
            `Stripped spoofed internal header "${header}" from external request ` +
              `(ip=${req.ip ?? 'unknown'}, path=${req.path})`,
          );
          // Reflect.deleteProperty — same idiom as VerifiedUserAssertionMiddleware;
          // satisfies @typescript-eslint/no-dynamic-delete for a loop-variable key.
          Reflect.deleteProperty(req.headers, header);
        }
      }
    }
    next();
  }

  /**
   * Validate that the request is from a trusted internal service.
   *
   * # Contract
   *
   * Requires a strict v2 service-identity signature. Legacy proof-of-secret
   * possession is no longer accepted for the strip-or-trust decision because
   * it does not bind path/body/query/audience and could preserve spoofed
   * user headers on a tampered request.
   */
  private verifyInternalRequest(req: Request): VerifiedServiceIdentity | undefined {
    const headers = req.headers as Record<string, string | string[] | undefined>;
    const identity = getServiceIdentityHeader(headers, 'x-service-identity');
    const signature = getServiceIdentityHeader(headers, 'x-service-signature');
    if (!identity || !signature) return undefined;

    const tenantHeader = getServiceIdentityHeader(headers, 'x-tenant-id') ?? '';
    const outcome = verifyServiceIdentityRequest({
      headers,
      observedMethod: req.method ?? 'GET',
      observedPath: this.canonicalisePath(req),
      observedQuery: this.canonicaliseQuery(req),
      observedContentType: getServiceIdentityHeader(headers, 'content-type') ?? '',
      observedAssertionHash: this.assertionHash(headers),
      observedBody: serializeServiceIdentityBodyForHash(req),
      secret: this.serviceSecret,
      keyring: this.keyring,
      allowUnscopedDevKey: process.env['NODE_ENV'] !== 'production',
      expectedTenantId: tenantHeader,
      expectedAudiences: this.expectedAudiences,
    });
    if (!outcome.valid) return undefined;
    return {
      serviceName: outcome.serviceName,
      tenantId: tenantHeader,
      effectiveTenantId: outcome.effectiveTenantId,
      keyId: outcome.keyId,
      audience: outcome.audience,
      nonce: outcome.nonce,
      version: 'v2',
    };
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

  private canonicalisePath(req: { path?: string; originalUrl?: string; url?: string }): string {
    // Use the full wire path when Express has mounted a route and `path`
    // becomes mount-relative. This must match ServiceIdentityGuard.
    const raw = req.originalUrl ?? req.url ?? req.path ?? '/';
    const qIdx = raw.indexOf('?');
    return qIdx === -1 ? raw : raw.slice(0, qIdx);
  }

  private resolveExpectedAudiences(): readonly string[] {
    const configured =
      this.configService.get<string>('SERVICE_IDENTITY_AUDIENCE') ??
      process.env['SERVICE_IDENTITY_AUDIENCE'];
    if (configured && configured.trim().length > 0) {
      return [configured.trim()];
    }

    const serviceId =
      this.configService.get<string>('SERVICE_IDENTITY_SERVICE_ID') ??
      this.configService.get<string>('SERVICE_NAME') ??
      process.env['SERVICE_IDENTITY_SERVICE_ID'] ??
      process.env['SERVICE_NAME'];
    const catalogAudiences = serviceId ? serviceIdentityAudiencesForService(serviceId) : [];
    if (catalogAudiences.length > 0) {
      return catalogAudiences;
    }

    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(
        'SERVICE_IDENTITY_AUDIENCE or catalog-backed SERVICE_NAME is required in production. ' +
          'Internal-header trust must not infer receiver audience from SERVICE_IDENTITY_KEYRING.',
      );
    }

    return [];
  }
}
