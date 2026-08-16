import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from, throwError } from 'rxjs';
import { switchMap, catchError } from 'rxjs/operators';
import { DataSource, QueryRunner } from 'typeorm';

import { getRequestFromArgumentsHost } from '../context/execution-context-request';
import { getRequestContext } from '../logging/request-context';
import { SENSITIVE_FIELDS_SET } from '../security/security-constants';

import { AuditLogEntity, AuditMethod, AuditResult, AuditSeverity } from './audit-log.entity';
import {
  AUDITED_OPERATION_KEY,
  AuditedOperationOptions,
  AuditedOperationStatus,
} from './audited-operation.decorator';
import { hashIpForGdpr, readIpHashingPolicyFromEnv, shouldHashIp } from './ip-hash.util';

/**
 * AUDITTRAIL-LOW-001 cure: re-export the canonical SENSITIVE_FIELDS_SET
 * under the local SENSITIVE_KEYS name so the interceptor's redaction loop
 * consumes the single source of truth from
 * `libs/backend-common/src/security/security-constants.ts` (alongside the
 * structured logger). Pre-fix this file declared its own 12-entry Set
 * that diverged from the logger's 11-entry regex, leaving keys like
 * 'access_token' (underscore) redacted in logs but written verbatim to
 * audit metadata, and keys like 'cvv' redacted in audit but logged
 * verbatim. Using the canonical SET means a new sensitive key added
 * to security-constants.ts is automatically picked up here.
 *
 * The Set is keyed by lowercase forms — the existing
 * `SENSITIVE_KEYS.has(key.toLowerCase())` lookup at line ~440 still
 * works because the canonical Set normalises every spelling to lower-
 * case before insertion (see security-constants.ts SENSITIVE_FIELDS_SET).
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set(
  Array.from(SENSITIVE_FIELDS_SET).map((k) => k.toLowerCase()),
);

/**
 * Maximum depth for sanitizing nested objects
 */
const MAX_SANITIZE_DEPTH = 3;

/**
 * AuditedOperationInterceptor
 *
 * NestJS interceptor that implements the @AuditedOperation() decorator contract.
 *
 * ## Key differences from the legacy AuditLogInterceptor:
 *
 * | Aspect                | Legacy AuditLogInterceptor      | AuditedOperationInterceptor       |
 * |-----------------------|---------------------------------|-----------------------------------|
 * | Audit write mode      | Fire-and-forget (.catch)        | AWAITED — failure = operation failure |
 * | Transaction support   | None (separate write)           | Uses same QueryRunner if available |
 * | Failure handling      | Swallows silently               | Throws InternalServerErrorException |
 * | Error audit           | Also fire-and-forget            | AWAITED — guaranteed persistence  |
 * | CQRS support          | HTTP/GraphQL only               | HTTP, GraphQL, AND CQRS handlers  |
 *
 * ## How it works:
 *
 * 1. Reads @AuditedOperation() metadata via Reflector (checks both handler and class)
 * 2. Extracts user identity from request context (JWT) or CQRS command metadata
 * 3. Extracts tenantId from request context or command
 * 4. BEFORE handler: captures timestamp, userId, tenantId, action, resource
 * 5. AFTER handler: writes audit entry (SUCCESS) — AWAITED
 * 6. On handler failure: writes audit entry (FAILED) with error message — AWAITED
 * 7. On audit write failure: throws InternalServerErrorException (NEVER swallows)
 *
 * ## Transaction integration:
 *
 * If the request object carries a `queryRunner` property (set by a transactional
 * middleware or decorator), the audit row is written through that QueryRunner so
 * it participates in the same DB transaction. If the transaction rolls back, the
 * audit row rolls back too — no phantom audits for failed operations.
 *
 * If no QueryRunner is available (e.g. GraphQL resolver without explicit txn),
 * the audit is written as a separate operation but is still AWAITED — never
 * fire-and-forget.
 */
@Injectable()
export class AuditedOperationInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditedOperationInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly dataSource: DataSource,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // ── Read metadata ──
    // Check handler method first, then fall back to class (for @CommandHandler)
    const options =
      this.reflector.get<AuditedOperationOptions | undefined>(
        AUDITED_OPERATION_KEY,
        context.getHandler(),
      ) ??
      this.reflector.get<AuditedOperationOptions | undefined>(
        AUDITED_OPERATION_KEY,
        context.getClass(),
      );

    if (!options) {
      return next.handle();
    }

    // ── Pre-execution capture ──
    const capturedAt = new Date();
    const requestCtx = this.extractRequestContext(context);
    const extractedDetails = this.extractDetails(options, context);

    return next.handle().pipe(
      // ── Success path ──
      switchMap((result: unknown) => {
        const resourceId = this.resolveResourceId(options, result);
        return from(
          this.writeAuditEntry(
            options,
            requestCtx,
            capturedAt,
            AuditedOperationStatus.SUCCESS,
            resourceId,
            extractedDetails,
            null,
          ),
        ).pipe(
          // After audit write succeeds, return the original result
          switchMap(() => [result]),
        );
      }),
      // ── Failure path ──
      catchError((handlerError: Error) => {
        return from(
          this.writeAuditEntry(
            options,
            requestCtx,
            capturedAt,
            AuditedOperationStatus.FAILED,
            null,
            extractedDetails,
            handlerError.message,
          ),
        ).pipe(
          // After audit write succeeds, re-throw the original handler error
          switchMap(() => throwError(() => handlerError)),
          // If audit write ALSO fails, throw an InternalServerError that
          // wraps both the original error and the audit failure
          catchError((auditWriteError: Error) => {
            this.logger.error(
              `AUDIT_WRITE_FAILURE: Could not persist FAILED audit entry ` +
                `for ${options.action} on ${options.resource}. ` +
                `Original error: ${handlerError.message}. ` +
                `Audit error: ${auditWriteError.message}`,
            );
            return throwError(
              () =>
                new InternalServerErrorException(
                  `Operation failed and audit trail could not be written. ` +
                    `Original: ${handlerError.message}`,
                ),
            );
          }),
        );
      }),
      // ── Audit write failure on SUCCESS path ──
      // The switchMap above can fail if writeAuditEntry rejects.
      // We need a top-level catch for that scenario.
      catchError((error: Error) => {
        // If this is already an InternalServerErrorException from our audit
        // failure handler above, just re-throw it
        if (error instanceof InternalServerErrorException) {
          return throwError(() => error);
        }
        // This catches audit write failures on the SUCCESS path
        this.logger.error(
          `AUDIT_WRITE_FAILURE: Could not persist SUCCESS audit entry ` +
            `for ${options.action} on ${options.resource}. ` +
            `Error: ${error.message}`,
        );
        return throwError(
          () =>
            new InternalServerErrorException(
              'Operation succeeded but audit trail could not be written. ' +
                'The operation has been aborted for compliance.',
            ),
        );
      }),
    );
  }

  /**
   * Write the audit entry to the database.
   *
   * If a QueryRunner is available on the request, uses it so the audit row
   * participates in the same transaction as the business operation.
   * Otherwise writes directly via the DataSource manager.
   *
   * IMPORTANT: This method is always AWAITED — never fire-and-forget.
   *
   * @throws Error if the database write fails (caller must handle)
   */
  private async writeAuditEntry(
    options: AuditedOperationOptions,
    ctx: RequestContext,
    capturedAt: Date,
    status: AuditedOperationStatus,
    resourceId: string | null,
    extractedDetails: Record<string, unknown> | null,
    errorMessage: string | null,
  ): Promise<void> {
    const metadata: Record<string, unknown> = {};

    if (options.description) {
      metadata['description'] = options.description;
    }
    if (extractedDetails && Object.keys(extractedDetails).length > 0) {
      metadata['details'] = this.sanitizeObject(extractedDetails);
    }
    if (errorMessage) {
      metadata['error'] = errorMessage;
    }
    metadata['status'] = status;

    const auditEntry: Partial<AuditLogEntity> = {
      action: `${options.action}_${options.resource}`.toUpperCase(),
      resource: options.resource,
      resourceId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      tenantId: ctx.tenantId,
      schemaName: ctx.schemaName,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
      // AUDITTRAIL-LOW-002 cure: route the IP through the
      // canonical region-gated hashing decision. ctx.region is
      // populated from the JWT residency claim (when present) by
      // buildContextFromRequest below. The deployment-wide
      // policy comes from env vars (AUDIT_FORCE_IP_HASH +
      // AUDIT_HASH_UNKNOWN_REGIONS) so non-EU deployments keep
      // plaintext behaviour until they explicitly opt in. The
      // helper centralizes the matrix; future per-tenant
      // residency lookups become a one-line change to ctx.region
      // population.
      ip: shouldHashIp(ctx.region, readIpHashingPolicyFromEnv())
        ? hashIpForGdpr(ctx.ipAddress)
        : ctx.ipAddress,
      userAgent: ctx.userAgent,
      severity: status === AuditedOperationStatus.FAILED ? AuditSeverity.ERROR : AuditSeverity.INFO,
      correlationId: ctx.correlationId,

      // ── AUDITTRAIL-CRITICAL-004 mandatory-shape population ──
      // These four fields the interceptor knows from request context and
      // execution status. The remaining four (preStateHash, postStateHash,
      // justification, relatedAuditIds) are caller-domain knowledge — they
      // travel with the AuditedOperationOptions metadata extracted by the
      // decorator, or are emitted by callers writing directly via
      // auditLogService.recordAwait. Leaving them undefined here is the
      // architecturally correct default — the interceptor neither has nor
      // should fabricate the entity-state hashes or override-justification.
      actorHomeTenantId: ctx.tenantId,
      actedOnTenantId: ctx.tenantId,
      method: ctx.method,
      mfaVerified: ctx.mfaVerified,
      result: status === AuditedOperationStatus.SUCCESS ? AuditResult.SUCCESS : AuditResult.FAILED,
    };

    // ── Transaction-aware write ──
    if (ctx.queryRunner && !ctx.queryRunner.isReleased) {
      // IMPORTANT: Write through the same QueryRunner so the audit row
      // is part of the same transaction as the business operation.
      await ctx.queryRunner.manager.save(AuditLogEntity, auditEntry);
    } else {
      // No transaction is available, so use the DataSource manager's entity
      // write primitive and AWAIT the result. AuditLogEntity is a declared
      // cross-tenant shared ledger and the row already carries the trusted
      // tenant identity; a tenant repository would incorrectly rewrite it.
      await this.dataSource.manager.save(AuditLogEntity, auditEntry);
    }
  }

  // ── Context extraction helpers ──

  /**
   * Extract request context from the execution context.
   * Supports HTTP, GraphQL, and RPC (CQRS) execution contexts.
   *
   * # Method derivation (AUDITTRAIL-CRITICAL-004)
   *
   * The Nest contextType drives the audit `method` field directly.
   * Anchoring it here means a future ContextType (e.g. websocket) only
   * needs a single mapping update rather than a sweep across every
   * audit caller.
   */
  private extractRequestContext(context: ExecutionContext): RequestContext {
    const contextType = context.getType<string>();

    if (contextType === 'graphql') {
      return { ...this.extractFromGraphQL(context), method: AuditMethod.GRAPHQL };
    }

    if (contextType === 'http') {
      return { ...this.extractFromHttp(context), method: AuditMethod.HTTP };
    }

    // RPC / CQRS context — bus-driven (NATS in this platform).
    return { ...this.extractFromRpc(context), method: AuditMethod.NATS };
  }

  /**
   * Extract context from an HTTP request (REST controllers)
   */
  private extractFromHttp(context: ExecutionContext): RequestContext {
    const request = context.switchToHttp().getRequest<RequestLike>();
    return this.buildContextFromRequest(request);
  }

  /**
   * Extract context from a GraphQL execution context
   */
  private extractFromGraphQL(context: ExecutionContext): RequestContext {
    const request = getRequestFromArgumentsHost<RequestLike>(context);
    return this.buildContextFromRequest(request);
  }

  /**
   * Extract context from an RPC/CQRS execution context.
   *
   * # Trust-anchor priority (AUDITTRAIL-MEDIUM-002 cure)
   *
   * Pre-cure this method read tenantId / userId / correlationId / etc.
   * exclusively from the command object. If the command author
   * forgot to populate `tenantId` on the DTO, the audit row's
   * `tenantId` was null even though the upstream HTTP middleware
   * had resolved a tenant context and run the entire CQRS chain
   * inside a `requestContextStorage.run({ tenantId, ... }, fn)`.
   *
   * The cure walks two trust anchors in order:
   *
   *   1. `requestContextStorage` (AsyncLocalStorage). This is the
   *      canonical SSoT for tenant + user identity once
   *      TenantContextMiddleware has run on the request. It
   *      survives across every async boundary including CQRS
   *      command-bus dispatch.
   *   2. The command object itself, as a secondary signal for the
   *      cron / event-bus / worker entry-points where no upstream
   *      HTTP middleware ran. Those callers MUST wrap their dispatch
   *      in `withTenantContext(...)` (see
   *      libs/backend-common/src/context/with-tenant-context.ts) —
   *      but until that migration is universal, command-property
   *      fallback keeps the audit row tenantId-attributed instead
   *      of nullifying it on a regression class that's still being
   *      swept.
   *
   * Why the ALS context is the trust anchor: it was populated by
   * TenantContextMiddleware which read the JWT (or the cron-side
   * `withTenantContext()` wrapper which validates the UUID), so the
   * value cannot be tampered with by a forgotten or maliciously-
   * crafted command DTO. The command-property fallback is a Tier-2
   * (make-automatic) compatibility shim, not a Tier-1 trust anchor.
   */
  private extractFromRpc(context: ExecutionContext): RequestContext {
    const args = context.getArgs<unknown[]>();
    const command = args[0] as Record<string, unknown> | undefined;
    const ctx = getRequestContext();

    return {
      userId: ctx.userId ?? (command?.['userId'] as string | undefined) ?? null,
      userEmail: (command?.['userEmail'] as string) ?? null,
      tenantId: ctx.tenantId ?? (command?.['tenantId'] as string | undefined) ?? null,
      schemaName: ctx.schemaName ?? (command?.['schemaName'] as string | undefined) ?? null,
      ipAddress: ctx.ip ?? (command?.['ipAddress'] as string | undefined) ?? null,
      userAgent: null,
      correlationId:
        ctx.correlationId ?? (command?.['correlationId'] as string | undefined) ?? null,
      queryRunner: (command?.['queryRunner'] as QueryRunner) ?? null,
      // method is set by extractRequestContext after this returns;
      // a non-null override at this layer would be ignored by the spread.
      method: null,
      mfaVerified: command?.['mfaVerified'] === true,
      // AUDITTRAIL-LOW-002: residency claim on the command DTO
      // (when present) drives the IP-hashing decision. CQRS
      // command authors include `region` for compliance-sensitive
      // commands. Absent → null → policy fallback.
      region: (command?.['region'] as string | undefined) ?? null,
    };
  }

  /**
   * Build a RequestContext from an HTTP-like request object.
   */
  private buildContextFromRequest(request: RequestLike | undefined): RequestContext {
    if (!request) {
      return {
        userId: null,
        userEmail: null,
        tenantId: null,
        schemaName: null,
        ipAddress: null,
        userAgent: null,
        correlationId: null,
        queryRunner: null,
        method: null,
        mfaVerified: false,
        region: null,
      };
    }

    const user = request.user;
    const headers = request.headers ?? {};

    return {
      userId: user?.sub ?? user?.id ?? null,
      userEmail: user?.email ?? null,
      // AUDITTRAIL-MEDIUM-003 cure (canonical interceptor sibling):
      // tenantId comes ONLY from the JWT trust anchor. Header
      // fallback removed for the same confused-deputy reason
      // documented on the legacy AuditLogInterceptor. Pre-auth /
      // cross-tenant-admin / edge-device flows do not run through
      // this interceptor (it fires on @AuditedOperation handlers,
      // all of which sit behind authentication). Truthful null is
      // better than an attacker-controllable header value.
      tenantId: user?.tenantId ?? null,
      schemaName: (headers['x-schema-name'] as string) ?? null,
      ipAddress: this.extractIp(request),
      userAgent: (headers['user-agent'] as string) ?? null,
      correlationId: (headers['x-correlation-id'] as string) ?? null,
      queryRunner: ((request as Record<string, unknown>)['queryRunner'] as QueryRunner) ?? null,
      // method is overwritten by extractRequestContext after this returns.
      method: null,
      mfaVerified: user?.['mfaVerified'] === true,
      // AUDITTRAIL-LOW-002: residency from JWT claim. Null when
      // the deployment doesn't propagate region on the token,
      // letting the policy fallback decide hashing.
      region: (user?.['region'] as string | undefined) ?? null,
    };
  }

  /**
   * Extract client IP from the request.
   * Considers X-Forwarded-For for proxied requests.
   */
  private extractIp(request: RequestLike): string | null {
    const forwarded = request.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0]?.trim() ?? null;
    }
    return request.ip ?? null;
  }

  /**
   * Extract additional details using the decorator's extractDetails function.
   */
  private extractDetails(
    options: AuditedOperationOptions,
    context: ExecutionContext,
  ): Record<string, unknown> | null {
    if (!options.extractDetails) {
      return null;
    }

    try {
      const args = context.getArgs<unknown[]>();
      return options.extractDetails(args);
    } catch (err) {
      this.logger.warn(
        `Failed to extract audit details for ${options.action} on ${options.resource}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Resolve the resource ID from the handler result.
   * Uses custom extractor if provided, otherwise looks for common patterns.
   */
  private resolveResourceId(options: AuditedOperationOptions, result: unknown): string | null {
    // ── Custom extractor ──
    if (options.extractResourceId) {
      try {
        return options.extractResourceId(result);
      } catch {
        return null;
      }
    }

    // ── Default extraction ──
    if (result === null || result === undefined) {
      return null;
    }
    if (typeof result === 'string') {
      return result;
    }
    if (typeof result === 'number') {
      return String(result);
    }
    if (typeof result === 'object') {
      const obj = result as Record<string, unknown>;
      if (typeof obj['id'] === 'string') {
        return obj['id'];
      }
      if (typeof obj['id'] === 'number') {
        return String(obj['id']);
      }
    }
    return null;
  }

  // ── Sanitization ──

  /**
   * Sanitize an object by removing sensitive keys and truncating deep nesting.
   * Prevents passwords, tokens, and other secrets from appearing in audit logs.
   */
  private sanitizeObject(obj: Record<string, unknown>, depth = 0): Record<string, unknown> {
    if (depth >= MAX_SANITIZE_DEPTH) {
      return { _truncated: true };
    }

    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        result[key] = '[REDACTED]';
        continue;
      }

      if (value === null || value === undefined) {
        result[key] = value;
      } else if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
        result[key] = this.sanitizeObject(value as Record<string, unknown>, depth + 1);
      } else if (Array.isArray(value)) {
        result[key] = value.slice(0, 10);
      } else {
        result[key] = value;
      }
    }

    return result;
  }
}

/**
 * Minimal request shape for extracting audit context.
 * Avoids tight coupling to Express/Fastify types.
 */
interface RequestLike {
  user?: {
    sub?: string;
    id?: string;
    email?: string;
    tenantId?: string | null;
    [key: string]: unknown;
  };
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  ip?: string;
}

/**
 * Extracted request context for audited operations.
 * Includes QueryRunner reference for transaction-aware writes.
 *
 * # method (AUDITTRAIL-CRITICAL-004)
 *
 * Channel through which the audited action arrived. Derived once at
 * extraction time (HTTP context → HTTP, GraphQL context → GRAPHQL,
 * RPC/CQRS context → NATS — the bus carrying CQRS commands across
 * services in this platform). CRON / CLI flows do not pass through
 * this interceptor, so those values are emitted by callers writing
 * directly via `auditLogService.recordAwait`.
 *
 * # mfaVerified (AUDITTRAIL-CRITICAL-004)
 *
 * Derived from the JWT claim `mfaVerified` if the auth pipeline placed
 * it on `request.user`. Defaults to false when absent — semantically
 * safe (a missing claim is treated as not-stepped-up; SOC 2 step-up
 * evidence reports filter on TRUE only).
 */
interface RequestContext {
  userId: string | null;
  userEmail: string | null;
  tenantId: string | null;
  schemaName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  correlationId: string | null;
  queryRunner: QueryRunner | null;
  method: AuditMethod | null;
  mfaVerified: boolean;
  /**
   * Tenant residency region marker (AUDITTRAIL-LOW-002).
   *
   * Derived from the JWT claim `region` (when minted with one)
   * or from the upstream OPA decision attribute. Null when the
   * deployment doesn't propagate residency on the JWT — in that
   * case `shouldHashIp` falls back to the deployment-level
   * `AUDIT_HASH_UNKNOWN_REGIONS` policy switch.
   */
  region: string | null;
}
