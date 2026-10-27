import { isModuleAccess } from '@aquaculture/shared-contracts';
import { BadRequestException, Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import type { VerifiedUserAssertion, TenantRequest } from '../types/tenant-request.interface';

const ASSERTION_HEADER = 'x-verified-user-assertion';
const LEGACY_IDENTITY_HEADERS = [
  'x-user-payload',
  'x-user-id',
  'x-user-roles',
  'x-act-as-tenant',
  'x-act-as-reason',
  'x-act-as-ticket',
] as const;

const ASSERTION_MAX_AGE_MS = 5 * 60 * 1000;
const TENANT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Introspection/service-health detection for the assertion exemption. Must
 * match __schema, the __type(...) meta-field and the `_service {` federation
 * SDL fetch — but never __typename, which is ordinary client vocabulary.
 */
const INTROSPECTION_OR_SERVICE_RE = /__schema\b|__type(?!name)\b|_service\s*\{/;

/**
 * Parses the gateway-minted farm identity assertion after service HMAC
 * verification and quarantines legacy raw identity headers.
 */
@Injectable()
export class VerifiedUserAssertionMiddleware implements NestMiddleware {
  private readonly logger = new Logger(VerifiedUserAssertionMiddleware.name);

  use(req: TenantRequest, res: Response, next: NextFunction): void {
    try {
      const assertionHeader = this.getHeader(req, ASSERTION_HEADER);

      if (!req.verifiedIdentity && this.requiresServiceIdentity(req)) {
        throw new BadRequestException('Subgraph request requires service identity');
      }

      if (!assertionHeader && this.requiresGatewayAssertion(req)) {
        // The gateway forwarded a bearer credential without a matching
        // verified user assertion — the token failed verification at the
        // gateway (expired or silently rejected), so no user context was ever
        // minted into an assertion. That is an AUTHENTICATION failure, not a
        // malformed request: answer with a GraphQL UNAUTHENTICATED error so
        // the browser api-client's session detector triggers the automatic
        // refresh + retry instead of surfacing an intermittent 400 the user
        // cannot recover from.
        this.rejectInvalidAccessToken(req, res);
        return;
      }

      if (assertionHeader) {
        if (!req.verifiedIdentity) {
          throw new BadRequestException('Verified user assertion requires service identity');
        }
        if (req.verifiedIdentity.serviceName !== 'gateway-api') {
          throw new BadRequestException(
            'Verified user assertion issuer must match gateway service identity',
          );
        }

        const assertion = this.parseAssertion(assertionHeader);
        if (!assertion.subject) {
          throw new BadRequestException('Verified user assertion is missing subject');
        }
        if (
          req.verifiedIdentity.tenantId &&
          assertion.effectiveTenantId !== req.verifiedIdentity.tenantId
        ) {
          throw new BadRequestException(
            'Verified user assertion tenant does not match signed service tenant',
          );
        }

        req.verifiedUserAssertion = assertion;
        req.tenantId = assertion.effectiveTenantId ?? assertion.tenantId ?? undefined;
        // ADR-0007: rebuild the validated act-as context from the signed claims
        // so the audit interceptor attributes the write to the actor's home
        // tenant and records the justification.
        if (assertion.actAs) {
          if (typeof assertion.actAs.reason !== 'string' || assertion.actAs.reason.length === 0) {
            throw new BadRequestException(
              'Verified user assertion act-as claims are missing a reason',
            );
          }
          if (!req.tenantId) {
            throw new BadRequestException(
              'Verified user assertion act-as claims require an effective tenant',
            );
          }
          req.actAs = {
            homeTenantId: assertion.actAs.homeTenantId ?? null,
            reason: assertion.actAs.reason,
            ticket: assertion.actAs.ticket ?? null,
            targetTenantId: req.tenantId,
            mfaVerified: assertion.mfaVerified === true,
          };
        }
        req.user = {
          sub: assertion.subject,
          tenantId: req.tenantId,
          roles: assertion.roles,
          email: assertion.email ?? undefined,
          mfaVerified: assertion.mfaVerified,
          // RBAC-HIGH-028: the per-module grants reach every resolver on the production path;
          // the member caller (userCaller) is built from them. Absent means no grants.
          ...(assertion.moduleAccess !== undefined ? { moduleAccess: assertion.moduleAccess } : {}),
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
          ...(assertion.planLevel !== undefined ? { planLevel: assertion.planLevel } : {}),
          // MT-HIGH-054: expose the tenant-RBAC capabilities so subgraph
          // @RequireTenantPermission / hasResourcePermission work on the prod
          // gateway path. Without this every non-admin fails closed on any
          // capability-gated route (a functional outage — same class as the
          // sites/mobileFeatures fix above).
          ...(assertion.resourcePermissions !== undefined
            ? { resourcePermissions: assertion.resourcePermissions }
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

  /**
   * Answer an unassertable bearer credential directly with a well-formed
   * GraphQL error envelope (HTTP 200 + errors[]). Middleware rejections do
   * not pass through the application's GraphQL exception filter — the filter
   * is what maps HttpException → GraphQL error codes for resolvers — so a
   * thrown BadRequestException would leave the service as a bare 400 JSON
   * body whose message the Apollo gateway never propagates as a GraphQL
   * error. Writing the envelope here guarantees the gateway forwards the
   * extensions.code UNAUTHENTICATED to the browser, where the api-client's
   * session detector (extensions.code === 'UNAUTHENTICATED' OR message
   * matching 'Invalid access token') runs the token refresh + retry.
   */
  private rejectInvalidAccessToken(req: TenantRequest, res: Response): void {
    this.logger.warn(
      `Rejected gateway subgraph request carrying a bearer credential without a verified user assertion on ${req.method} ${req.originalUrl ?? req.url}`,
    );
    res.status(200).json({
      errors: [
        {
          message: 'Invalid access token',
          extensions: { code: 'UNAUTHENTICATED' },
        },
      ],
    });
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
    // RBAC-HIGH-028 (ADR-051 §2): moduleAccess is absent only from a gateway of the previous
    // release (no grants); when present it must be the claim's exact shape — owner modules of
    // the dictionary mapped to module roles. alert, ai, unknown codes, account roles and any
    // other shape are a malformed claim, answered with 400 like every claim below.
    if (candidate.moduleAccess !== undefined && !isModuleAccess(candidate.moduleAccess)) {
      throw new BadRequestException('Verified user assertion has invalid moduleAccess');
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
    // MT-HIGH-054: resourcePermissions is optional but, when present, must be a
    // string[] — reject a malformed claim fail-closed (mirrors the checks above).
    if (!this.isOptionalStringArray(candidate.resourcePermissions)) {
      throw new BadRequestException('Verified user assertion has invalid resourcePermissions');
    }
    // SSOT-C-13: planLevel is optional, but when present must be a finite
    // number — reject a malformed claim fail-closed (mirrors the checks above).
    if (
      candidate.planLevel !== undefined &&
      (typeof candidate.planLevel !== 'number' || !Number.isFinite(candidate.planLevel))
    ) {
      throw new BadRequestException('Verified user assertion has invalid planLevel');
    }
    // ORPHAN-MEDIUM-319: optional client network identity — when present each
    // must be a bounded string (an IP literal is <= 45 chars incl. IPv6; the
    // UA cap mirrors common proxy limits). Reject malformed values
    // fail-closed like every other claim.
    if (!this.isOptionalBoundedString(candidate.clientIp, 64)) {
      throw new BadRequestException('Verified user assertion has invalid clientIp');
    }
    if (!this.isOptionalBoundedString(candidate.clientUserAgent, 1024)) {
      throw new BadRequestException('Verified user assertion has invalid clientUserAgent');
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
      moduleAccess: candidate.moduleAccess,
      assignedSiteIds: candidate.assignedSiteIds,
      mobileFeatures: candidate.mobileFeatures,
      resourcePermissions: candidate.resourcePermissions,
      planLevel: candidate.planLevel,
      clientIp: candidate.clientIp ?? null,
      clientUserAgent: candidate.clientUserAgent ?? null,
    };
  }

  /**
   * An optional claim is valid iff it is undefined OR a string[] whose members
   * are all strings. A non-array or a non-string member is a malformed claim
   * and is rejected fail-closed by the caller.
   */
  /**
   * An optional scalar claim is valid iff it is undefined, null, or a
   * non-empty string within the length bound.
   */
  private isOptionalBoundedString(
    value: unknown,
    maxLength: number,
  ): value is string | null | undefined {
    if (value === undefined || value === null) {
      return true;
    }
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
  }

  private isOptionalStringArray(value: unknown): value is string[] | undefined {
    if (value === undefined) {
      return true;
    }
    return Array.isArray(value) && value.every((member) => typeof member === 'string');
  }

  private requiresGatewayAssertion(req: TenantRequest): boolean {
    return (
      this.requiresServiceIdentity(req) &&
      req.verifiedIdentity?.serviceName === 'gateway-api' &&
      this.hasAuthorizationHeader(req)
    );
  }

  /**
   * Public login/refresh GraphQL operations are still transported by the
   * certificate-authenticated gateway but have no authenticated user to bind
   * into an assertion. Once a bearer credential is present, the matching
   * gateway assertion is mandatory and fail-closed.
   */
  private hasAuthorizationHeader(req: TenantRequest): boolean {
    const authorization = this.getHeader(req, 'authorization');
    return typeof authorization === 'string' && authorization.trim().length > 0;
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
    // `__type(?!name)\b` matches the introspection meta-field __type but NOT
    // __typename — every GraphQL client sprinkles __typename through ordinary
    // queries, and the old substring includes() exempted those from the
    // verified-assertion requirement. `_service\s*\{` keeps the Apollo
    // Router poller (RetryableIntrospectAndCompose sends `_service { sdl }`)
    // exempt without exempting arbitrary text mentioning _service.
    return INTROSPECTION_OR_SERVICE_RE.test(compact);
  }

  private getHeader(req: Request, name: string): string | undefined {
    const value = req.headers[name.toLowerCase()] ?? req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }
}
