import { BadRequestException, Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import type { VerifiedUserAssertion, TenantRequest } from '../types/tenant-request.interface';

const ASSERTION_HEADER = 'x-verified-user-assertion';
const LEGACY_IDENTITY_HEADERS = [
  'x-user-payload',
  'x-user-id',
  'x-user-roles',
  'x-act-as-tenant',
] as const;

const ASSERTION_MAX_AGE_MS = 5 * 60 * 1000;
const TENANT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parses the gateway-minted farm identity assertion after service HMAC
 * verification and quarantines legacy raw identity headers.
 */
@Injectable()
export class VerifiedUserAssertionMiddleware implements NestMiddleware {
  private readonly logger = new Logger(VerifiedUserAssertionMiddleware.name);

  use(req: TenantRequest, _res: Response, next: NextFunction): void {
    try {
      const assertionHeader = this.getHeader(req, ASSERTION_HEADER);

      if (!req.verifiedIdentity && this.requiresServiceIdentity(req)) {
        throw new BadRequestException('Subgraph request requires service identity');
      }

      if (!assertionHeader && this.requiresGatewayAssertion(req)) {
        throw new BadRequestException(
          'Verified user assertion is required for gateway subgraph requests',
        );
      }

      if (assertionHeader) {
        if (!req.verifiedIdentity) {
          throw new BadRequestException('Verified user assertion requires service identity');
        }
        if (req.verifiedIdentity.serviceName !== 'gateway-api') {
          throw new BadRequestException('Verified user assertion issuer must match gateway service identity');
        }

        const assertion = this.parseAssertion(assertionHeader);
        if (!assertion.subject) {
          throw new BadRequestException('Verified user assertion is missing subject');
        }
        if (
          req.verifiedIdentity.tenantId &&
          assertion.effectiveTenantId !== req.verifiedIdentity.tenantId
        ) {
          throw new BadRequestException('Verified user assertion tenant does not match signed service tenant');
        }

        req.verifiedUserAssertion = assertion;
        req.tenantId = assertion.effectiveTenantId ?? assertion.tenantId ?? undefined;
        req.user = {
          sub: assertion.subject,
          tenantId: req.tenantId,
          roles: assertion.roles,
          email: assertion.email ?? undefined,
          mfaVerified: assertion.mfaVerified,
          // SEC-HIGH-051 / SEC-HIGH-052: expose the object-level authorization
          // claims on the PRODUCTION gateway path (where req.user is rebuilt
          // from the assertion, NOT the raw JWT). Without this the claims would
          // be undefined at every prod resolver and all non-managers would
          // fail-closed — a functional outage.
          ...(assertion.assignedSiteIds !== undefined
            ? { assignedSiteIds: assertion.assignedSiteIds }
            : {}),
          ...(assertion.mobileFeatures !== undefined
            ? { mobileFeatures: assertion.mobileFeatures }
            : {}),
          // SSOT-C-13: expose the plan tier ordinal so resource-create handlers
          // can enforce per-plan quotas on the production gateway path.
          ...(assertion.planLevel !== undefined
            ? { planLevel: assertion.planLevel }
            : {}),
        };

        // Once the gateway assertion is the authoritative identity, drop the
        // legacy identity headers so UserContextMiddleware cannot re-derive a
        // different (or forged) user from them. Strip ONLY when an assertion is
        // present: in dev/E2E (no assertion) the legacy x-user-payload path is
        // the test harness's identity source, and a no-assertion PRODUCTION
        // gateway request is already rejected above (requiresGatewayAssertion),
        // while StripInternalHeadersMiddleware removes spoofable headers from
        // non-signed production requests. Stripping unconditionally here broke
        // every subgraph E2E that authenticates via x-user-payload.
        for (const header of LEGACY_IDENTITY_HEADERS) {
          if (req.headers[header]) {
            Reflect.deleteProperty(req.headers, header);
          }
        }
      }

      next();
    } catch (error) {
      this.logger.warn(
        `Rejected verified user assertion on ${req.method} ${req.originalUrl ?? req.url}: ${(error as Error).message}`,
      );
      next(error);
    }
  }

  private parseAssertion(value: string): VerifiedUserAssertion {
    let decoded: string;
    try {
      decoded = Buffer.from(value, 'base64url').toString('utf8');
    } catch {
      throw new BadRequestException('Verified user assertion is not valid base64url');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      throw new BadRequestException('Verified user assertion is not valid JSON');
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new BadRequestException('Verified user assertion must be an object');
    }

    const candidate = parsed as Partial<VerifiedUserAssertion>;
    if (candidate.issuer !== 'gateway-api' || typeof candidate.subject !== 'string') {
      throw new BadRequestException('Verified user assertion has invalid issuer or subject');
    }
    if (
      !Array.isArray(candidate.roles) ||
      candidate.roles.some((role) => typeof role !== 'string')
    ) {
      throw new BadRequestException('Verified user assertion roles must be strings');
    }
    if (typeof candidate.issuedAt !== 'string') {
      throw new BadRequestException('Verified user assertion has invalid issuedAt');
    }
    const issuedAtMs = Date.parse(candidate.issuedAt);
    if (Number.isNaN(issuedAtMs) || Math.abs(Date.now() - issuedAtMs) > ASSERTION_MAX_AGE_MS) {
      throw new BadRequestException('Verified user assertion is expired or not yet valid');
    }
    if (
      !this.isOptionalTenant(candidate.tenantId) ||
      !this.isOptionalTenant(candidate.effectiveTenantId)
    ) {
      throw new BadRequestException('Verified user assertion has invalid tenant');
    }
    if (candidate.assertionId !== undefined && typeof candidate.assertionId !== 'string') {
      throw new BadRequestException('Verified user assertion has invalid assertionId');
    }
    // SEC-HIGH-051 / SEC-HIGH-052: the object-level authorization claims are
    // optional, but when present each must be a string[] whose members are all
    // strings — reject a malformed claim fail-closed (mirrors the roles check).
    if (!this.isOptionalStringArray(candidate.assignedSiteIds)) {
      throw new BadRequestException('Verified user assertion has invalid assignedSiteIds');
    }
    if (!this.isOptionalStringArray(candidate.mobileFeatures)) {
      throw new BadRequestException('Verified user assertion has invalid mobileFeatures');
    }
    // SSOT-C-13: planLevel is optional, but when present must be a finite
    // number — reject a malformed claim fail-closed (mirrors the checks above).
    if (
      candidate.planLevel !== undefined &&
      (typeof candidate.planLevel !== 'number' || !Number.isFinite(candidate.planLevel))
    ) {
      throw new BadRequestException('Verified user assertion has invalid planLevel');
    }

    return {
      issuer: candidate.issuer,
      subject: candidate.subject,
      tenantId: candidate.tenantId ?? null,
      effectiveTenantId: candidate.effectiveTenantId ?? candidate.tenantId ?? null,
      roles: candidate.roles,
      email: candidate.email ?? null,
      mfaVerified: candidate.mfaVerified ?? false,
      issuedAt: candidate.issuedAt,
      assertionId: candidate.assertionId,
      assignedSiteIds: candidate.assignedSiteIds,
      mobileFeatures: candidate.mobileFeatures,
      planLevel: candidate.planLevel,
    };
  }

  /**
   * An optional claim is valid iff it is undefined OR a string[] whose members
   * are all strings. A non-array or a non-string member is a malformed claim
   * and is rejected fail-closed by the caller.
   */
  private isOptionalStringArray(value: unknown): value is string[] | undefined {
    if (value === undefined) {
      return true;
    }
    return Array.isArray(value) && value.every((member) => typeof member === 'string');
  }

  private requiresGatewayAssertion(req: TenantRequest): boolean {
    return (
      this.requiresServiceIdentity(req) &&
      req.verifiedIdentity?.serviceName === 'gateway-api'
    );
  }

  private requiresServiceIdentity(req: TenantRequest): boolean {
    return (
      process.env['NODE_ENV'] === 'production' &&
      !this.isProbePath(req) &&
      !this.isIntrospectionQuery(req.body as { query?: string; operationName?: string } | undefined)
    );
  }

  private isProbePath(req: Request): boolean {
    const rawPath = req.originalUrl ?? req.url ?? req.path ?? '/';
    const path = rawPath.split('?')[0] || '/';
    return (
      path === '/metrics' ||
      path === '/health' ||
      path.startsWith('/health/') ||
      path === '/api/metrics' ||
      path === '/api/health' ||
      path.startsWith('/api/health/')
    );
  }

  private isOptionalTenant(value: unknown): boolean {
    return (
      value === undefined ||
      value === null ||
      (typeof value === 'string' && TENANT_UUID_RE.test(value))
    );
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
    if (typeof query !== 'string') {
      return false;
    }
    const compact = query.replace(/\s+/g, ' ');
    return (
      compact.includes('__schema') || compact.includes('__type') || compact.includes('_service')
    );
  }

  private getHeader(req: Request, name: string): string | undefined {
    const value = req.headers[name.toLowerCase()] ?? req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }
}
