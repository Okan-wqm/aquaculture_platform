import * as crypto from 'crypto';
import { isIP } from 'net';

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RedisService } from '@aquaculture/backend-common/redis';
import {
  DEFAULT_IMPERSONATION_PERMISSIONS,
  IMPERSONATION_BOOLEAN_GRANTS,
  IMPERSONATION_AUTHORIZATION_RECEIPT_VERSION,
  IMPERSONATION_AUTHORIZATION_OPERATION_LIMIT,
  IMPERSONATION_MODULES,
  IMPERSONATION_PERMISSION_FIELDS,
  canonicalWireJsonContentSha256V1,
  canonicalWireJsonSha256V1,
  compileImpersonationAuthorizationOperationsV1,
  compileImpersonationPermissionsV1,
  containsAsciiControlCharacter,
  decodeCanonicalImpersonationAuthorizationOperationsV1,
  decodeCanonicalImpersonationPermissionsV1,
  evaluateImpersonationAuthorization,
  impersonationAuthorizationRequestDigestV1,
  impersonationAuthorizationOperationSetDigestV1,
  isImpersonationContextId,
  isImpersonationCredential,
  isImpersonationModule,
  type ImpersonationBooleanGrant,
  type ImpersonationAuthorizationReceiptCoordinateV1,
  type ImpersonationOperationDescriptor,
} from '@aquaculture/shared-contracts';
import { AuditLogService, type MandatoryTransactionalAuditInput } from '../../audit/audit.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  LessThan,
  In,
  MoreThan,
  type EntityManager,
  type FindOptionsWhere,
  type Repository,
} from 'typeorm';

import {
  ImpersonationSession,
  ImpersonationPermission,
  ImpersonationStatus,
  ImpersonationReason,
  ImpersonationPermissions,
  ImpersonationAction,
  ImpersonationAuthorizationDecision,
  ImpersonationAuthorizationReceipt,
  ImpersonationAuthorizationOperationReceipt,
  SafeImpersonationSession,
  toSafeImpersonationSession,
  IMPERSONATION_MAX_SESSION_MINUTES,
} from '../entities/impersonation-session.entity';
import {
  createStandardPaginatedResult,
  IStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';

/**
 * Start-impersonation response: the safe session view PLUS the raw
 * impersonation token, revealed exactly once to the initiating super-admin so
 * they can drive the session. Never carries `originalSessionToken`.
 */
export type StartedImpersonationSession = SafeImpersonationSession & {
  impersonationToken: string;
};

// ============================================================================
// Interfaces
// ============================================================================

export interface StartImpersonationRequest {
  superAdminId: string;
  /** Optional: email was removed from JWT in H-08 (PII reduction). Falls back
   *  to ID-only audit trail when not present. */
  superAdminEmail?: string;
  targetTenantId: string;
  targetTenantName?: string;
  targetUserId?: string;
  targetUserEmail?: string;
  reason: ImpersonationReason;
  reasonDetails?: string;
  ticketReference?: string;
  permissions?: Partial<ImpersonationPermissions>;
  durationMinutes?: number;
  ipAddress: string;
  userAgent: string;
  mfaVerified: boolean;
}

export interface ImpersonationContext {
  sessionId: string;
  superAdminId: string;
  targetTenantId: string;
  targetUserId?: string;
  permissions: ImpersonationPermissions;
  expiresAt: Date;
  isActive: boolean;
}

export interface AuthorizeImpersonationRequest
  extends ImpersonationAuthorizationReceiptCoordinateV1 {
  readonly credential: string;
  readonly requestDigest: string;
}

export interface ImpersonationAuthorizationReceiptResult {
  readonly authorizationReceiptId: string;
  readonly requestDigest: string;
  readonly replayed: boolean;
  readonly context: ImpersonationContext;
}

export interface AuthorizeImpersonationOperationsRequest extends AuthorizeImpersonationRequest {
  readonly operations: readonly ImpersonationOperationDescriptor[];
  readonly operationSetDigest: string;
}

export interface ImpersonationAuditSummary {
  totalSessions: number;
  activeSessions: number;
  sessionsByReason: Record<ImpersonationReason, number>;
  topImpersonators: Array<{ adminId: string; email: string; sessionCount: number }>;
  topTargetTenants: Array<{ tenantId: string; tenantName: string; sessionCount: number }>;
  recentSessions: SafeImpersonationSession[];
}

function assertPartialImpersonationPermissions(
  value: Partial<ImpersonationPermissions> | undefined,
): void {
  if (value === undefined) return;
  for (const field of Object.keys(value)) {
    if (!(IMPERSONATION_PERMISSION_FIELDS as readonly string[]).includes(field)) {
      throw new BadRequestException(`Unknown impersonation permission field: ${field}`);
    }
  }
  for (const grant of IMPERSONATION_BOOLEAN_GRANTS) {
    if (value[grant] !== undefined && typeof value[grant] !== 'boolean') {
      throw new BadRequestException(`Impersonation permission ${grant} must be boolean`);
    }
  }
  for (const moduleField of ['allowedModules', 'restrictedModules'] as const) {
    const modules = value[moduleField];
    if (
      modules !== undefined &&
      (!Array.isArray(modules) || !modules.every(isImpersonationModule))
    ) {
      throw new BadRequestException(
        `Impersonation permission ${moduleField} contains a non-canonical module`,
      );
    }
  }
  if (
    !compileImpersonationPermissionsV1({
      ...DEFAULT_IMPERSONATION_PERMISSIONS,
      ...value,
    })
  ) {
    throw new BadRequestException(
      'Impersonation module lists must use canonical vocabulary, be unique, and be disjoint',
    );
  }
}

function effectiveSessionPermissions(
  granted: ImpersonationPermissions,
  requested: Partial<ImpersonationPermissions> | undefined,
): ImpersonationPermissions {
  assertPartialImpersonationPermissions(requested);
  const boolean = (grant: ImpersonationBooleanGrant, defaultToGrant: boolean): boolean =>
    granted[grant] && (requested?.[grant] ?? (defaultToGrant ? granted[grant] : false));

  const requestedAllowed = requested?.allowedModules;
  if (
    requestedAllowed !== undefined &&
    granted.allowedModules !== undefined &&
    requestedAllowed.some((module) => !granted.allowedModules?.includes(module))
  ) {
    throw new ForbiddenException('Requested modules exceed the impersonation grant');
  }
  const allowedModules = requestedAllowed ?? granted.allowedModules;
  const restrictedModules = Object.freeze(
    IMPERSONATION_MODULES.filter(
      (module) =>
        granted.restrictedModules?.includes(module) === true ||
        requested?.restrictedModules?.includes(module) === true,
    ),
  );

  const compiled = compileImpersonationPermissionsV1({
    canViewData: boolean('canViewData', true),
    canModifyData: boolean('canModifyData', false),
    canAccessSettings: boolean('canAccessSettings', false),
    canManageUsers: boolean('canManageUsers', false),
    canViewBilling: boolean('canViewBilling', false),
    canExportData: boolean('canExportData', false),
    ...(allowedModules !== undefined ? { allowedModules: [...allowedModules] } : {}),
    ...(restrictedModules.length > 0 ? { restrictedModules } : {}),
  });
  if (!compiled) {
    throw new ForbiddenException('Effective impersonation module policy is contradictory');
  }
  return compiled;
}

const IMPERSONATION_RATE_LIMIT_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return {count, redis.call('TTL', KEYS[1])}
`;

/** Explicit live-session storage bounds; terminalization retires all rows. */
const IMPERSONATION_RECEIPT_CAP_PER_SESSION = 10_000;
const IMPERSONATION_OPERATION_RECEIPT_CAP_PER_SESSION = 25_000;

function decodeRateLimitResult(value: unknown): readonly [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'number' ||
    !Number.isSafeInteger(value[0]) ||
    typeof value[1] !== 'number' ||
    !Number.isSafeInteger(value[1])
  ) {
    throw new ServiceUnavailableException('Impersonation rate-limit store returned invalid data');
  }
  return [value[0], value[1]];
}

function requestedPositiveInteger(
  value: number | undefined,
  defaultValue: number,
  maximum: number,
  field: string,
): number {
  const resolved = value ?? defaultValue;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new BadRequestException(`${field} must be an integer between 1 and ${maximum}`);
  }
  return resolved;
}

function storedPositiveInteger(value: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new ForbiddenException(`Stored ${field} policy is invalid`);
  }
  return value;
}

function assertCanonicalSessionBinding(request: StartImpersonationRequest): void {
  if (
    !isImpersonationContextId(request.superAdminId) ||
    !isImpersonationContextId(request.targetTenantId) ||
    (request.targetUserId !== undefined && !isImpersonationContextId(request.targetUserId))
  ) {
    throw new BadRequestException('Impersonation identity must use canonical UUID text');
  }
  if (isIP(request.ipAddress) === 0) {
    throw new BadRequestException('A canonical client IP is required for impersonation');
  }
  if (
    request.userAgent.length === 0 ||
    request.userAgent.length > 1024 ||
    request.userAgent !== request.userAgent.trim() ||
    containsAsciiControlCharacter(request.userAgent)
  ) {
    throw new BadRequestException('A canonical client user agent is required for impersonation');
  }
  if (request.mfaVerified !== true) {
    throw new ForbiddenException('MFA verification is required for impersonation');
  }
}

function canonicalTenantList(
  value: string[] | undefined,
  field: 'allowedTenants' | 'restrictedTenants',
): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    value.some((tenantId) => !isImpersonationContextId(tenantId)) ||
    new Set(value).size !== value.length
  ) {
    throw new BadRequestException(`${field} must contain unique canonical tenant UUIDs`);
  }
  return [...value].sort();
}

function isCanonicalTenantList(value: unknown): value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return false;
  }
  if (
    value.some((tenantId) => !isImpersonationContextId(tenantId)) ||
    new Set(value).size !== value.length
  ) {
    return false;
  }
  const sorted = [...value].sort();
  return value.every((tenantId, index) => tenantId === sorted[index]);
}

// ============================================================================
// Impersonation Service
// ============================================================================

@Injectable()
export class ImpersonationService implements OnModuleDestroy {
  private readonly logger = new Logger(ImpersonationService.name);
  private readonly TOKEN_EXPIRY_BUFFER_MS = 60000; // 1 minute

  // SECURITY: Rate limiting for impersonation attempts
  private static readonly RATE_LIMIT_MAX_ATTEMPTS = 5;
  private static readonly RATE_LIMIT_WINDOW_SECONDS = 300; // 5 minutes
  private readonly useRedis: boolean;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  /** In-memory fallback — single-instance only, not distributed */
  private readonly localRateLimitMap: Map<string, { count: number; resetAt: number }> = new Map();

  constructor(
    @InjectRepository(ImpersonationSession)
    private readonly sessionRepo: Repository<ImpersonationSession>,
    @InjectRepository(ImpersonationPermission)
    private readonly permissionRepo: Repository<ImpersonationPermission>,
    @InjectRepository(ImpersonationAuthorizationReceipt)
    private readonly authorizationReceiptRepo: Repository<ImpersonationAuthorizationReceipt>,
    @InjectRepository(ImpersonationAuthorizationOperationReceipt)
    private readonly authorizationOperationReceiptRepo: Repository<ImpersonationAuthorizationOperationReceipt>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    @Optional() private readonly redisService?: RedisService,
  ) {
    this.useRedis = !!this.redisService;
    if (!this.useRedis) {
      if (process.env['NODE_ENV'] === 'production') {
        throw new Error('RedisService is required for production impersonation rate limiting');
      }
      this.logger.warn(
        'Impersonation rate limiting using in-memory Map — NOT distributed. ' +
          'Multi-instance deployments bypass rate limits.',
      );
    }
    // Clean up in-memory rate limit entries for non-production, single-process
    // development only. Production construction fails closed without Redis.
    if (!this.useRedis) {
      this.cleanupTimer = setInterval(() => this.cleanupRateLimitMap(), 60000);
      this.cleanupTimer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.localRateLimitMap.clear();
  }

  private async databaseNow(entityManager: Pick<EntityManager, 'query'>): Promise<Date> {
    const result: unknown = await entityManager.query('SELECT clock_timestamp() AS "databaseNow"');
    if (!Array.isArray(result) || result.length !== 1) {
      throw new ServiceUnavailableException('Database clock authority is unavailable');
    }
    const row: unknown = result[0];
    if (typeof row !== 'object' || row === null || !('databaseNow' in row)) {
      throw new ServiceUnavailableException('Database clock authority returned invalid data');
    }
    const rawTimestamp = row.databaseNow;
    const parsed = rawTimestamp instanceof Date ? rawTimestamp : new Date(String(rawTimestamp));
    if (!Number.isFinite(parsed.getTime())) {
      throw new ServiceUnavailableException('Database clock authority returned invalid data');
    }
    return parsed;
  }

  private async recordRequiredAudit(
    entityManager: EntityManager,
    input: MandatoryTransactionalAuditInput,
  ): Promise<void> {
    try {
      await this.auditLogService.appendInTransaction(entityManager, input);
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'impersonation_required_audit_failed',
          action: input.action,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      throw new ServiceUnavailableException('Impersonation audit trail is unavailable');
    }
  }

  /**
   * The session ledger and required audit event share the default PostgreSQL
   * DataSource. Persist them through one EntityManager so no active/changed
   * impersonation session can exist without its matching forensic event.
   */
  private async saveSessionWithRequiredAudit(
    entityManager: EntityManager,
    session: ImpersonationSession,
    auditInput: (saved: ImpersonationSession) => MandatoryTransactionalAuditInput,
  ): Promise<ImpersonationSession> {
    const saved = await entityManager.withRepository(this.sessionRepo).save(session);
    await this.recordRequiredAudit(entityManager, auditInput(saved));
    if (saved.status !== ImpersonationStatus.ACTIVE) {
      // Receipt rows are bounded live-session idempotency state. The required
      // audit row above is the durable evidence; terminalization retires the
      // mutable replay surface in the SAME transaction.
      await entityManager.query(
        'SELECT "admin".retire_impersonation_authorization_receipts($1::uuid)',
        [saved.id],
      );
    }
    return saved;
  }

  private async findLockedSession(
    entityManager: EntityManager,
    where: FindOptionsWhere<ImpersonationSession>,
  ): Promise<ImpersonationSession | null> {
    return entityManager.withRepository(this.sessionRepo).findOne({
      where,
      lock: { mode: 'pessimistic_write' },
    });
  }

  private appendSessionAction(session: ImpersonationSession, action: ImpersonationAction): void {
    session.actionsPerformed = [...(session.actionsPerformed ?? []), action].slice(-1000);
    session.actionCount = (session.actionCount ?? 0) + 1;
  }

  // ── Rate Limiting ─────────────────────────────────────────────────────────

  /**
   * SECURITY: Check rate limit for impersonation attempts.
   * Prevents brute-force attacks on the impersonation endpoint.
   *
   * Uses Redis INCR + EXPIRE when available for distributed enforcement.
   * Falls back to in-memory Map for single-instance deployments.
   *
   * Redis key pattern: impersonate:ratelimit:{adminId}:{ip}
   * TTL: 300 seconds (5 minutes)
   *
   * @param key - Rate limit key (format: superAdminId:ipAddress)
   * @returns Whether the request is allowed and retry delay if blocked
   */
  private async checkRateLimit(key: string): Promise<{ allowed: boolean; retryAfterMs?: number }> {
    if (this.useRedis) {
      return this.checkRateLimitRedis(key);
    }
    return this.checkRateLimitLocal(key);
  }

  /**
   * Redis-backed rate limit using atomic INCR + EXPIRE.
   *
   * SECURITY: INCR is atomic — concurrent requests from the same admin
   * cannot race past the 5-attempt limit across multiple instances.
   */
  private async checkRateLimitRedis(
    key: string,
  ): Promise<{ allowed: boolean; retryAfterMs?: number }> {
    const redis = this.redisService;
    if (!redis) {
      throw new ServiceUnavailableException('Impersonation rate-limit store is unavailable');
    }
    const redisKey = `${redis.getKeyPrefix()}impersonate:ratelimit:${key}`;
    const [count, ttlRemaining] = decodeRateLimitResult(
      await redis
        .getClient()
        .eval(
          IMPERSONATION_RATE_LIMIT_LUA,
          1,
          redisKey,
          String(ImpersonationService.RATE_LIMIT_WINDOW_SECONDS),
        ),
    );

    if (count > ImpersonationService.RATE_LIMIT_MAX_ATTEMPTS) {
      return {
        allowed: false,
        retryAfterMs: Math.max(0, ttlRemaining * 1000),
      };
    }

    return { allowed: true };
  }

  /**
   * In-memory rate limit fallback for single-instance deployments.
   *
   * IMPORTANT: Does NOT work across multiple instances — each instance
   * maintains its own counter, allowing N× configured limit.
   */
  private checkRateLimitLocal(key: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const entry = this.localRateLimitMap.get(key);

    if (!entry || now > entry.resetAt) {
      const resetAt = now + ImpersonationService.RATE_LIMIT_WINDOW_SECONDS * 1000;
      this.localRateLimitMap.set(key, { count: 1, resetAt });
      return { allowed: true };
    }

    if (entry.count >= ImpersonationService.RATE_LIMIT_MAX_ATTEMPTS) {
      return { allowed: false, retryAfterMs: entry.resetAt - now };
    }

    entry.count++;
    return { allowed: true };
  }

  /**
   * Clean up expired in-memory rate limit entries.
   * Only runs when Redis is not available.
   */
  private cleanupRateLimitMap(): void {
    const now = Date.now();
    for (const [key, entry] of this.localRateLimitMap.entries()) {
      if (now > entry.resetAt) {
        this.localRateLimitMap.delete(key);
      }
    }
  }

  // ============================================================================
  // Permission Management
  // ============================================================================

  async grantImpersonationPermission(data: {
    superAdminId: string;
    superAdminEmail?: string;
    allowedTenants?: string[];
    restrictedTenants?: string[];
    defaultPermissions?: ImpersonationPermissions;
    maxSessionDurationMinutes?: number;
    maxConcurrentSessions?: number;
    requireReason?: boolean;
    requireTicketReference?: boolean;
    notifyTenantAdmin?: boolean;
    grantedBy: string;
    expiresAt?: Date;
    notes?: string;
  }): Promise<ImpersonationPermission> {
    if (!isImpersonationContextId(data.superAdminId) || !isImpersonationContextId(data.grantedBy)) {
      throw new BadRequestException('Impersonation permission identity must be canonical');
    }
    if (data.notifyTenantAdmin === true) {
      throw new BadRequestException(
        'Tenant-admin impersonation notification is unavailable until recipient resolution is authoritative',
      );
    }
    const allowedTenants = canonicalTenantList(data.allowedTenants, 'allowedTenants');
    const restrictedTenants = canonicalTenantList(data.restrictedTenants, 'restrictedTenants');
    if (allowedTenants?.some((tenantId) => restrictedTenants?.includes(tenantId) === true)) {
      throw new BadRequestException('allowedTenants and restrictedTenants must be disjoint');
    }
    const compiledDefaultPermissions = data.defaultPermissions
      ? compileImpersonationPermissionsV1(data.defaultPermissions)
      : undefined;
    if (data.defaultPermissions !== undefined && !compiledDefaultPermissions) {
      throw new BadRequestException('Default impersonation permissions are invalid');
    }
    const maxSessionDurationMinutes =
      data.maxSessionDurationMinutes === undefined
        ? undefined
        : requestedPositiveInteger(
            data.maxSessionDurationMinutes,
            IMPERSONATION_MAX_SESSION_MINUTES,
            IMPERSONATION_MAX_SESSION_MINUTES,
            'maxSessionDurationMinutes',
          );
    const maxConcurrentSessions =
      data.maxConcurrentSessions === undefined
        ? undefined
        : requestedPositiveInteger(data.maxConcurrentSessions, 3, 10, 'maxConcurrentSessions');
    const permissionData = {
      superAdminId: data.superAdminId,
      grantedBy: data.grantedBy,
      ...(data.superAdminEmail !== undefined ? { superAdminEmail: data.superAdminEmail } : {}),
      ...(allowedTenants !== undefined ? { allowedTenants } : {}),
      ...(restrictedTenants !== undefined ? { restrictedTenants } : {}),
      ...(data.requireReason !== undefined ? { requireReason: data.requireReason } : {}),
      ...(data.requireTicketReference !== undefined
        ? { requireTicketReference: data.requireTicketReference }
        : {}),
      ...(data.notifyTenantAdmin !== undefined
        ? { notifyTenantAdmin: data.notifyTenantAdmin }
        : {}),
      ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
      ...(compiledDefaultPermissions ? { defaultPermissions: compiledDefaultPermissions } : {}),
      ...(maxSessionDurationMinutes !== undefined ? { maxSessionDurationMinutes } : {}),
      ...(maxConcurrentSessions !== undefined ? { maxConcurrentSessions } : {}),
    };
    const saved = await this.dataSource.transaction(async (entityManager) => {
      await entityManager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `admin:impersonation-cap:${data.superAdminId}`,
      ]);
      const databaseNow = await this.databaseNow(entityManager);
      if (data.expiresAt && data.expiresAt <= databaseNow) {
        throw new BadRequestException('Impersonation permission expiry must be in the future');
      }
      const repository = entityManager.withRepository(this.permissionRepo);
      let permission = await repository.findOne({
        where: { superAdminId: data.superAdminId },
        lock: { mode: 'pessimistic_write' },
      });
      if (permission) {
        Object.assign(permission, {
          ...permissionData,
          canImpersonate: true,
          isActive: true,
          grantedAt: databaseNow,
        });
      } else {
        permission = repository.create({
          ...permissionData,
          canImpersonate: true,
          isActive: true,
          defaultPermissions: compiledDefaultPermissions ?? DEFAULT_IMPERSONATION_PERMISSIONS,
          maxSessionDurationMinutes: maxSessionDurationMinutes ?? IMPERSONATION_MAX_SESSION_MINUTES,
          maxConcurrentSessions: maxConcurrentSessions ?? 3,
          requireReason: data.requireReason ?? true,
          requireTicketReference: data.requireTicketReference ?? false,
          notifyTenantAdmin: data.notifyTenantAdmin ?? false,
          grantedAt: databaseNow,
        });
      }
      if (
        !isCanonicalTenantList(permission.allowedTenants) ||
        permission.allowedTenants.length === 0 ||
        (permission.restrictedTenants !== undefined &&
          !isCanonicalTenantList(permission.restrictedTenants)) ||
        permission.allowedTenants.some(
          (tenantId) => permission.restrictedTenants?.includes(tenantId) === true,
        )
      ) {
        throw new BadRequestException(
          'Enabled impersonation permissions require a non-empty canonical, disjoint tenant scope',
        );
      }
      const persisted = await repository.save(permission);
      await this.recordRequiredAudit(entityManager, {
        action: 'IMPERSONATION_PERMISSION_GRANTED',
        entityType: 'ImpersonationPermission',
        entityId: persisted.id,
        performedBy: data.grantedBy,
        details: {
          superAdminId: data.superAdminId,
          allowedTenants: persisted.allowedTenants,
          restrictedTenants: persisted.restrictedTenants,
          maxConcurrentSessions: persisted.maxConcurrentSessions,
          maxSessionDurationMinutes: persisted.maxSessionDurationMinutes,
          effectivePermissions: persisted.defaultPermissions,
        },
      });
      return persisted;
    });
    this.logger.log(JSON.stringify({ event: 'impersonation_permission_granted' }));
    return saved;
  }

  async revokeImpersonationPermission(superAdminId: string, revokedBy: string): Promise<void> {
    if (!isImpersonationContextId(superAdminId) || !isImpersonationContextId(revokedBy)) {
      throw new BadRequestException('Impersonation permission identity must be canonical');
    }
    await this.dataSource.transaction(async (entityManager) => {
      await entityManager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `admin:impersonation-cap:${superAdminId}`,
      ]);
      const permissionRepository = entityManager.withRepository(this.permissionRepo);
      const permission = await permissionRepository.findOne({
        where: { superAdminId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!permission) {
        throw new NotFoundException(`Permission not found for admin: ${superAdminId}`);
      }
      const databaseNow = await this.databaseNow(entityManager);
      permission.isActive = false;
      permission.canImpersonate = false;
      const persisted = await permissionRepository.save(permission);

      const sessionRepository = entityManager.withRepository(this.sessionRepo);
      const activeSessions = await sessionRepository
        .createQueryBuilder('session')
        .setLock('pessimistic_write')
        .where('session."superAdminId" = :superAdminId', { superAdminId })
        .andWhere('session."status" = :status', { status: ImpersonationStatus.ACTIVE })
        .orderBy('session."id"', 'ASC')
        .getMany();

      for (const session of activeSessions) {
        session.status = ImpersonationStatus.TERMINATED;
        session.endedAt = databaseNow;
        session.endReason = 'Impersonation permission revoked';
        session.impersonationToken = null;
        this.appendSessionAction(session, {
          action: 'permission_revoked',
          resource: 'impersonation_session',
          resourceId: session.id,
          timestamp: databaseNow.toISOString(),
        });
        await this.saveSessionWithRequiredAudit(entityManager, session, (savedSession) => ({
          action: 'IMPERSONATION_TERMINATED_PERMISSION_REVOKED',
          entityType: 'ImpersonationSession',
          entityId: savedSession.id,
          performedBy: revokedBy,
          tenantId: savedSession.targetTenantId,
          sessionId: savedSession.id,
          details: {
            sessionId: savedSession.id,
            sessionOwnerId: savedSession.superAdminId,
            endReason: savedSession.endReason,
          },
        }));
      }

      await this.recordRequiredAudit(entityManager, {
        action: 'IMPERSONATION_PERMISSION_REVOKED',
        entityType: 'ImpersonationPermission',
        entityId: persisted.id,
        performedBy: revokedBy,
        details: { superAdminId, terminatedSessionCount: activeSessions.length },
      });
    });

    this.logger.log(JSON.stringify({ event: 'impersonation_permission_revoked' }));
  }

  async getImpersonationPermission(superAdminId: string): Promise<ImpersonationPermission | null> {
    return this.permissionRepo.findOne({
      where: { superAdminId, isActive: true },
    });
  }

  async queryPermissions(params: {
    tenantId?: string;
    isActive?: boolean;
    page?: number;
    limit?: number;
  }): Promise<IStandardPaginatedResult<ImpersonationPermission>> {
    const query = this.permissionRepo.createQueryBuilder('p');

    if (params.tenantId) {
      query.andWhere('p."allowedTenants" @> CAST(:allowedTenant AS jsonb)', {
        allowedTenant: JSON.stringify([params.tenantId]),
      });
    }
    if (params.isActive !== undefined) {
      query.andWhere('p.isActive = :isActive', { isActive: params.isActive });
    }

    query.orderBy('p.grantedAt', 'DESC');

    const page = params.page || 1;
    const limit = params.limit || 20;
    query.skip((page - 1) * limit).take(limit);

    const [data, total] = await query.getManyAndCount();
    return createStandardPaginatedResult(data, total, page, limit);
  }

  async getImpersonationStats(): Promise<{
    activeSessions: number;
    totalSessions: number;
    activePermissions: number;
    topAdmins: Array<{ adminId: string; email: string; sessionCount: number }>;
    recentSessions: SafeImpersonationSession[];
  }> {
    const databaseNow = await this.databaseNow(this.dataSource.manager);
    const [activeSessions, totalSessions, activePermissions, topAdminsRaw, recentSessions] =
      await Promise.all([
        this.sessionRepo.count({
          where: { status: ImpersonationStatus.ACTIVE, expiresAt: MoreThan(databaseNow) },
        }),
        this.sessionRepo.count(),
        this.permissionRepo.count({ where: { isActive: true } }),
        this.sessionRepo
          .createQueryBuilder('s')
          .select('s.superAdminId', 'adminId')
          .addSelect('s.superAdminEmail', 'email')
          .addSelect('COUNT(*)', 'sessionCount')
          .groupBy('s.superAdminId')
          .addGroupBy('s.superAdminEmail')
          .orderBy('COUNT(*)', 'DESC')
          .limit(5)
          .getRawMany(),
        this.sessionRepo.find({
          order: { createdAt: 'DESC' },
          take: 5,
        }),
      ]);

    return {
      activeSessions,
      totalSessions,
      activePermissions,
      topAdmins: topAdminsRaw.map((r) => ({
        adminId: r.adminId || '',
        email: r.email || 'Unknown',
        sessionCount: parseInt(r.sessionCount, 10) || 0,
      })),
      // DB-ADMIN-HIGH-002: the stats read path must not serialize token columns.
      recentSessions: recentSessions.map(toSafeImpersonationSession),
    };
  }

  async canImpersonate(
    superAdminId: string,
    targetTenantId: string,
  ): Promise<{
    allowed: boolean;
    reason?: string;
    permission?: ImpersonationPermission;
  }> {
    if (!isImpersonationContextId(superAdminId) || !isImpersonationContextId(targetTenantId)) {
      throw new BadRequestException('Impersonation identity must use canonical UUID text');
    }
    return this.dataSource.transaction(async (entityManager) => {
      await entityManager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `admin:impersonation-cap:${superAdminId}`,
      ]);
      const databaseNow = await this.databaseNow(entityManager);
      const permission = await entityManager.withRepository(this.permissionRepo).findOne({
        where: { superAdminId, isActive: true },
        lock: { mode: 'pessimistic_read' },
      });
      const permissionDenial = this.impersonationPermissionDenial(
        permission,
        targetTenantId,
        databaseNow,
      );
      if (permissionDenial || !permission) {
        return { allowed: false, reason: permissionDenial };
      }
      const maxConcurrentSessions = storedPositiveInteger(
        permission.maxConcurrentSessions,
        10,
        'maxConcurrentSessions',
      );
      const activeSessions = await entityManager.withRepository(this.sessionRepo).count({
        where: {
          superAdminId,
          status: ImpersonationStatus.ACTIVE,
          expiresAt: MoreThan(databaseNow),
        },
      });
      if (activeSessions >= maxConcurrentSessions) {
        return { allowed: false, reason: 'Maximum concurrent sessions reached' };
      }
      return { allowed: true, permission };
    });
  }

  private impersonationPermissionDenial(
    permission: ImpersonationPermission | null,
    targetTenantId: string,
    databaseNow: Date,
  ): string | undefined {
    if (!permission) return 'No impersonation permission granted';
    if (!permission.canImpersonate) return 'Impersonation permission disabled';
    if (permission.expiresAt && permission.expiresAt <= databaseNow) {
      return 'Impersonation permission expired';
    }
    if (
      !isCanonicalTenantList(permission.allowedTenants) ||
      (permission.restrictedTenants !== undefined &&
        !isCanonicalTenantList(permission.restrictedTenants)) ||
      permission.allowedTenants.some(
        (tenantId) => permission.restrictedTenants?.includes(tenantId) === true,
      )
    ) {
      return 'Stored impersonation tenant scope is invalid';
    }
    if (permission.restrictedTenants?.includes(targetTenantId)) {
      return 'Tenant is restricted for impersonation';
    }
    if (permission.allowedTenants.length === 0) {
      return 'No allowed tenants configured - impersonation denied';
    }
    if (!permission.allowedTenants.includes(targetTenantId)) {
      return 'Tenant not in allowed list';
    }
    return undefined;
  }

  // ============================================================================
  // Session Management
  // ============================================================================

  async startImpersonation(
    request: StartImpersonationRequest,
  ): Promise<StartedImpersonationSession> {
    assertCanonicalSessionBinding(request);
    // SECURITY: Rate limiting based on admin ID and IP address
    const rateLimitKey = `impersonate:${request.superAdminId}:${request.ipAddress}`;
    const rateCheck = await this.checkRateLimit(rateLimitKey);

    if (!rateCheck.allowed) {
      const retryAfterSeconds = Math.ceil((rateCheck.retryAfterMs || 0) / 1000);
      this.logger.warn(JSON.stringify({ event: 'impersonation_rate_limit_exceeded' }));
      throw new ForbiddenException(
        `Too many impersonation attempts. Please try again in ${retryAfterSeconds} seconds.`,
      );
    }

    this.logger.log(JSON.stringify({ event: 'impersonation_attempt' }));

    const rawImpersonationToken = this.generateSecureToken();
    const impersonationToken = this.hashToken(rawImpersonationToken);
    const saved = await this.createSessionTransaction(request, impersonationToken);

    this.logger.log(JSON.stringify({ event: 'impersonation_started', sessionId: saved.id }));

    // C-5 fix: Return raw token to caller (only time it's available in plaintext).
    // Strip the stored credential hash and reveal the raw token exactly once.
    return { ...toSafeImpersonationSession(saved), impersonationToken: rawImpersonationToken };
  }

  private async createSessionTransaction(
    request: StartImpersonationRequest,
    impersonationToken: string,
  ): Promise<ImpersonationSession> {
    return this.dataSource.transaction(async (entityManager) => {
      await entityManager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `admin:impersonation-cap:${request.superAdminId}`,
      ]);
      const permissionRepository = entityManager.withRepository(this.permissionRepo);
      const permission = await permissionRepository.findOne({
        where: { superAdminId: request.superAdminId, isActive: true },
        lock: { mode: 'pessimistic_write' },
      });
      const databaseNow = await this.databaseNow(entityManager);
      const denial = this.impersonationPermissionDenial(
        permission,
        request.targetTenantId,
        databaseNow,
      );
      if (denial || !permission) throw new ForbiddenException(denial);
      if (permission.notifyTenantAdmin === true) {
        throw new ServiceUnavailableException(
          'Tenant-admin impersonation notification is not configured; session was not started',
        );
      }

      if (permission.requireReason && !request.reason) {
        throw new BadRequestException('Reason is required for impersonation');
      }
      if (permission.requireTicketReference && !request.ticketReference) {
        throw new BadRequestException('Ticket reference is required for impersonation');
      }

      const sessionRepository = entityManager.withRepository(this.sessionRepo);
      const maxConcurrentSessions = storedPositiveInteger(
        permission.maxConcurrentSessions,
        10,
        'maxConcurrentSessions',
      );
      const activeSessions = await sessionRepository.count({
        where: {
          superAdminId: request.superAdminId,
          status: ImpersonationStatus.ACTIVE,
          expiresAt: MoreThan(databaseNow),
        },
      });
      if (activeSessions >= maxConcurrentSessions) {
        throw new ForbiddenException('Maximum concurrent sessions reached');
      }

      const grantedPermissions = decodeCanonicalImpersonationPermissionsV1(
        permission.defaultPermissions,
      );
      if (!grantedPermissions) {
        throw new ForbiddenException('Stored impersonation permissions are invalid');
      }
      const permissions = effectiveSessionPermissions(grantedPermissions, request.permissions);
      const maxSessionDurationMinutes = storedPositiveInteger(
        permission.maxSessionDurationMinutes,
        IMPERSONATION_MAX_SESSION_MINUTES,
        'maxSessionDurationMinutes',
      );
      const durationMinutes = requestedPositiveInteger(
        request.durationMinutes,
        maxSessionDurationMinutes,
        maxSessionDurationMinutes,
        'durationMinutes',
      );
      const session = sessionRepository.create({
        superAdminId: request.superAdminId,
        superAdminEmail: request.superAdminEmail,
        targetTenantId: request.targetTenantId,
        targetTenantName: request.targetTenantName,
        targetUserId: request.targetUserId,
        targetUserEmail: request.targetUserEmail,
        status: ImpersonationStatus.ACTIVE,
        reason: request.reason,
        reasonDetails: request.reasonDetails,
        ticketReference: request.ticketReference,
        permissions,
        ipAddress: request.ipAddress,
        userAgent: request.userAgent,
        impersonationToken,
        mfaCompleted: true,
        expiresAt: new Date(databaseNow.getTime() + durationMinutes * 60_000),
        actionsPerformed: [],
        accessedResources: [],
        actionCount: 0,
      });
      const saved = await sessionRepository.save(session);
      await this.recordRequiredAudit(entityManager, {
        action: 'IMPERSONATION_STARTED',
        entityType: 'ImpersonationSession',
        entityId: saved.id,
        performedBy: request.superAdminId,
        tenantId: request.targetTenantId,
        sessionId: saved.id,
        ipAddress: request.ipAddress,
        userAgent: request.userAgent,
        details: {
          sessionId: saved.id,
          targetTenantId: request.targetTenantId,
          targetUserId: request.targetUserId,
          reason: request.reason,
          reasonDetails: request.reasonDetails,
          ticketReference: request.ticketReference,
          durationMinutes,
          effectivePermissions: permissions,
        },
      });
      return saved;
    });
  }

  async endImpersonation(
    sessionId: string,
    endReason?: string,
    endedBy?: string,
  ): Promise<SafeImpersonationSession> {
    const saved = await this.dataSource.transaction(async (entityManager) => {
      const session = await this.findLockedSession(entityManager, { id: sessionId });
      if (!session) throw new NotFoundException(`Session not found: ${sessionId}`);
      if (session.status !== ImpersonationStatus.ACTIVE) {
        throw new BadRequestException(`Session is not active: ${session.status}`);
      }
      if (endedBy && session.superAdminId !== endedBy) {
        throw new ForbiddenException('Bu oturumu sonlandırma yetkiniz yok');
      }
      const databaseNow = await this.databaseNow(entityManager);
      session.status = ImpersonationStatus.ENDED;
      session.endedAt = databaseNow;
      session.endReason = endReason || (endedBy ? 'Ended by user' : 'Manual termination');
      session.impersonationToken = null;
      return this.saveSessionWithRequiredAudit(entityManager, session, (persisted) => ({
        action: 'IMPERSONATION_ENDED',
        entityType: 'ImpersonationSession',
        entityId: persisted.id,
        performedBy: endedBy || persisted.superAdminId,
        tenantId: persisted.targetTenantId,
        sessionId: persisted.id,
        details: {
          sessionId: persisted.id,
          endReason: persisted.endReason,
          durationActualMinutes:
            persisted.endedAt && persisted.createdAt
              ? Math.round((persisted.endedAt.getTime() - persisted.createdAt.getTime()) / 60_000)
              : null,
        },
      }));
    });

    this.logger.log(JSON.stringify({ event: 'impersonation_ended', sessionId }));

    // DB-ADMIN-HIGH-002: the end response is session state, not a credential
    // channel — strip the stored token columns like every other response path.
    return toSafeImpersonationSession(saved);
  }

  async terminateSession(
    sessionId: string,
    terminatedBy: string,
    reason: string,
  ): Promise<SafeImpersonationSession> {
    const saved = await this.dataSource.transaction(async (entityManager) => {
      const session = await this.findLockedSession(entityManager, { id: sessionId });
      if (!session) throw new NotFoundException(`Session not found: ${sessionId}`);
      if (session.status !== ImpersonationStatus.ACTIVE) {
        throw new BadRequestException(`Session is not active: ${session.status}`);
      }
      const databaseNow = await this.databaseNow(entityManager);
      session.status = ImpersonationStatus.TERMINATED;
      session.endedAt = databaseNow;
      session.endReason = `Terminated by ${terminatedBy}: ${reason}`;
      session.impersonationToken = null;
      return this.saveSessionWithRequiredAudit(entityManager, session, (persisted) => ({
        action: 'IMPERSONATION_TERMINATED',
        entityType: 'ImpersonationSession',
        entityId: persisted.id,
        performedBy: terminatedBy,
        tenantId: persisted.targetTenantId,
        sessionId: persisted.id,
        details: {
          sessionId: persisted.id,
          sessionOwnerId: persisted.superAdminId,
          endReason: persisted.endReason,
          terminationReason: reason,
        },
      }));
    });

    this.logger.warn(JSON.stringify({ event: 'impersonation_terminated', sessionId }));

    // DB-ADMIN-HIGH-002: never echo the stored token columns on the terminate response.
    return toSafeImpersonationSession(saved);
  }

  /**
   * Extend an active impersonation session
   * Fix: H21 -- extend session endpoint
   */
  async extendSession(
    sessionId: string,
    additionalMinutes: number,
    extendedBy: string,
  ): Promise<SafeImpersonationSession> {
    requestedPositiveInteger(
      additionalMinutes,
      additionalMinutes,
      IMPERSONATION_MAX_SESSION_MINUTES,
      'additionalMinutes',
    );
    const saved = await this.dataSource.transaction(async (entityManager) => {
      const sessionRepository = entityManager.withRepository(this.sessionRepo);
      const candidate = await sessionRepository.findOne({ where: { id: sessionId } });
      if (!candidate) throw new NotFoundException(`Session not found: ${sessionId}`);
      await entityManager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `admin:impersonation-cap:${candidate.superAdminId}`,
      ]);
      const permission = await entityManager.withRepository(this.permissionRepo).findOne({
        where: { superAdminId: candidate.superAdminId, isActive: true },
        lock: { mode: 'pessimistic_read' },
      });
      const session = await this.findLockedSession(entityManager, { id: sessionId });
      if (!session) throw new NotFoundException(`Session not found: ${sessionId}`);
      if (session.status !== ImpersonationStatus.ACTIVE) {
        throw new BadRequestException(`Session is not active: ${session.status}`);
      }
      if (session.superAdminId !== extendedBy) {
        throw new ForbiddenException('Bu oturumu uzatma yetkiniz yok');
      }
      if (!permission || !permission.canImpersonate) {
        throw new ForbiddenException('Impersonation permission is not active');
      }
      const databaseNow = await this.databaseNow(entityManager);
      if (this.impersonationPermissionDenial(permission, session.targetTenantId, databaseNow)) {
        throw new ForbiddenException('Impersonation permission is not active for this tenant');
      }
      if (session.expiresAt <= databaseNow) {
        throw new BadRequestException('Cannot extend an expired session');
      }
      const maxDurationMinutes = storedPositiveInteger(
        permission.maxSessionDurationMinutes,
        IMPERSONATION_MAX_SESSION_MINUTES,
        'maxSessionDurationMinutes',
      );
      const newExpiresAt = session.expiresAt.getTime() + additionalMinutes * 60_000;
      const totalDurationMinutes = (newExpiresAt - session.createdAt.getTime()) / 60_000;
      if (totalDurationMinutes > maxDurationMinutes) {
        throw new BadRequestException(
          `Toplam oturum suresi maksimum ${maxDurationMinutes} dakikayi asamaz`,
        );
      }
      session.expiresAt = new Date(newExpiresAt);
      this.appendSessionAction(session, {
        action: 'session_extended',
        resource: 'impersonation_session',
        resourceId: sessionId,
        timestamp: databaseNow.toISOString(),
        details: {
          additionalMinutes,
          newExpiresAt: session.expiresAt.toISOString(),
          extendedBy,
        },
      });
      return this.saveSessionWithRequiredAudit(entityManager, session, (persisted) => ({
        action: 'IMPERSONATION_EXTENDED',
        entityType: 'ImpersonationSession',
        entityId: persisted.id,
        performedBy: extendedBy,
        tenantId: persisted.targetTenantId,
        sessionId: persisted.id,
        details: {
          sessionId: persisted.id,
          additionalMinutes,
          newExpiresAt: persisted.expiresAt.toISOString(),
          sessionOwnerId: persisted.superAdminId,
        },
      }));
    });

    this.logger.log(
      JSON.stringify({ event: 'impersonation_extended', sessionId, additionalMinutes }),
    );

    // DB-ADMIN-HIGH-002: never echo the stored token columns on the extend response.
    return toSafeImpersonationSession(saved);
  }

  // ============================================================================
  // Gateway request authorization receipts
  // ============================================================================

  /**
   * Authorize one exact external request and write its idempotent receipt.
   * The gateway-minted receipt UUID is never accepted as authority by itself:
   * token, actor, tenant, IP/UA binding, session state, permission scope and
   * current permission/session generations are re-checked under DB locks on
   * every replay.
   */
  async resolveAuthorizationContext(
    request: AuthorizeImpersonationRequest,
  ): Promise<ImpersonationContext | null> {
    const { tokenHash } = this.assertAuthorizationRequest(request);
    return this.dataSource.transaction(async (entityManager) => {
      const sessionRepository = entityManager.withRepository(this.sessionRepo);
      const candidate = await sessionRepository.findOne({
        where: {
          id: request.sessionId,
          impersonationToken: tokenHash,
          status: ImpersonationStatus.ACTIVE,
        },
      });
      if (!candidate) return null;
      await entityManager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `admin:impersonation-cap:${candidate.superAdminId}`,
      ]);
      const permission = await entityManager.withRepository(this.permissionRepo).findOne({
        where: { superAdminId: candidate.superAdminId },
        lock: { mode: 'pessimistic_read' },
      });
      const session = await sessionRepository.findOne({
        where: { id: request.sessionId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!session || session.impersonationToken !== tokenHash) return null;
      const databaseNow = await this.databaseNow(entityManager);
      const permissions = decodeCanonicalImpersonationPermissionsV1(session.permissions);
      const grantedPermissions = decodeCanonicalImpersonationPermissionsV1(
        permission?.defaultPermissions ?? DEFAULT_IMPERSONATION_PERMISSIONS,
      );
      if (
        this.authorizationDenialReason(
          request,
          session,
          permission,
          permissions,
          grantedPermissions,
          databaseNow,
        ) ||
        !permissions
      ) {
        return null;
      }
      return this.authorizationContext(permissions, session);
    });
  }

  async authorizeOperations(
    request: AuthorizeImpersonationOperationsRequest,
  ): Promise<ImpersonationAuthorizationReceiptResult | null> {
    const { tokenHash, computedDigest } = this.assertAuthorizationRequest(request);
    const operations = compileImpersonationAuthorizationOperationsV1(request.operations);
    if (!operations || operations.length > IMPERSONATION_AUTHORIZATION_OPERATION_LIMIT) {
      throw new BadRequestException('Impersonation authorization operation set is not canonical');
    }
    const operationSetDigest = impersonationAuthorizationOperationSetDigestV1(operations);
    if (request.operationSetDigest !== operationSetDigest) {
      throw new BadRequestException('Impersonation operation-set digest does not match');
    }

    return this.dataSource.transaction(async (entityManager) => {
      const sessionRepository = entityManager.withRepository(this.sessionRepo);
      const candidate = await sessionRepository.findOne({
        where: {
          id: request.sessionId,
          impersonationToken: tokenHash,
          status: ImpersonationStatus.ACTIVE,
        },
      });
      if (!candidate) return null;
      await entityManager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `admin:impersonation-cap:${candidate.superAdminId}`,
      ]);
      const permission = await entityManager.withRepository(this.permissionRepo).findOne({
        where: { superAdminId: candidate.superAdminId },
        lock: { mode: 'pessimistic_read' },
      });
      const session = await this.findLockedSession(entityManager, { id: request.sessionId });
      if (!session || session.impersonationToken !== tokenHash) return null;
      const databaseNow = await this.databaseNow(entityManager);
      if (session.expiresAt <= databaseNow) {
        await this.expireLockedSession(entityManager, session, databaseNow);
        return null;
      }
      const permissions = decodeCanonicalImpersonationPermissionsV1(session.permissions);
      const grantedPermissions = decodeCanonicalImpersonationPermissionsV1(
        permission?.defaultPermissions ?? DEFAULT_IMPERSONATION_PERMISSIONS,
      );
      const bindingDenial = this.authorizationDenialReason(
        request,
        session,
        permission,
        permissions,
        grantedPermissions,
        databaseNow,
      );
      const operationDecision = permissions
        ? evaluateImpersonationAuthorization(permissions, operations)
        : undefined;
      const denialReason =
        bindingDenial ??
        (operationDecision?.allowed === true ? undefined : 'operation_not_permitted');
      const { sessionGeneration, permissionGeneration } = this.authorizationGenerations(
        session,
        permission,
      );

      const receiptRepository = entityManager.withRepository(this.authorizationReceiptRepo);
      let receipt = await receiptRepository.findOne({
        where: {
          sessionId: session.id,
          authorizationReceiptId: request.authorizationReceiptId,
        },
      });
      if (receipt && receipt.requestDigest !== computedDigest) {
        throw new ForbiddenException(
          'Authorization receipt ID was already used for a different request digest',
        );
      }
      if (
        receipt &&
        (receipt.sessionGeneration !== sessionGeneration ||
          receipt.permissionGeneration !== permissionGeneration)
      ) {
        return null;
      }
      if (!receipt) {
        const receiptCount = await receiptRepository.count({ where: { sessionId: session.id } });
        if (receiptCount >= IMPERSONATION_RECEIPT_CAP_PER_SESSION) {
          throw new ServiceUnavailableException('Impersonation receipt capacity is exhausted');
        }
        receipt = receiptRepository.create({
          sessionId: session.id,
          authorizationReceiptId: request.authorizationReceiptId,
          requestDigest: computedDigest,
          actorId: request.actorId,
          effectiveTenantId: request.effectiveTenantId,
          method: request.method,
          normalizedPath: request.normalizedPath,
          normalizedQueryHash: request.normalizedQueryHash,
          bodyHash: request.bodyHash,
          clientIp: request.clientIp,
          clientUserAgentHash: canonicalWireJsonContentSha256V1(request.clientUserAgent),
          sessionGeneration,
          permissionGeneration,
        });
        await receiptRepository.save(receipt);
      }

      const operationReceiptRepository = entityManager.withRepository(
        this.authorizationOperationReceiptRepo,
      );
      const siblingOperationReceipts = await operationReceiptRepository.find({
        where: {
          sessionId: session.id,
          authorizationReceiptId: request.authorizationReceiptId,
        },
      });
      const siblingOperationKeys = new Set<string>();
      let expectedSiblingUnionCardinality = 0;
      for (const sibling of siblingOperationReceipts) {
        const canonicalSibling = decodeCanonicalImpersonationAuthorizationOperationsV1(
          sibling.operations,
        );
        if (
          !canonicalSibling ||
          sibling.operationCount !== canonicalSibling.length ||
          sibling.operationSetDigest !==
            impersonationAuthorizationOperationSetDigestV1(canonicalSibling)
        ) {
          throw new ServiceUnavailableException(
            'Stored impersonation operation receipt is not canonical',
          );
        }
        expectedSiblingUnionCardinality += sibling.operationCount;
        for (const operation of canonicalSibling) {
          const key = `${operation.module}\u0000${operation.operation}`;
          if (siblingOperationKeys.has(key)) {
            throw new ServiceUnavailableException(
              'Stored impersonation operation receipt union overlaps',
            );
          }
          siblingOperationKeys.add(key);
        }
      }
      if (siblingOperationKeys.size !== expectedSiblingUnionCardinality) {
        throw new ServiceUnavailableException(
          'Stored impersonation operation receipt union cardinality diverged',
        );
      }
      const existingOperationReceipt = siblingOperationReceipts.find(
        (candidateReceipt) => candidateReceipt.operationSetDigest === operationSetDigest,
      );
      if (existingOperationReceipt) {
        if (
          existingOperationReceipt.decision !== ImpersonationAuthorizationDecision.AUTHORIZED ||
          existingOperationReceipt.sessionGeneration !== sessionGeneration ||
          existingOperationReceipt.permissionGeneration !== permissionGeneration ||
          denialReason ||
          !permissions
        ) {
          return null;
        }
        return this.authorizationReceiptResult(request, permissions, session, true);
      }
      const newOperationKeys = operations.map(
        (operation) => `${operation.module}\u0000${operation.operation}`,
      );
      if (newOperationKeys.some((key) => siblingOperationKeys.has(key))) {
        throw new ForbiddenException('Impersonation operation set overlaps a prior child receipt');
      }
      const expectedUnionCardinality = expectedSiblingUnionCardinality + operations.length;
      if (
        new Set([...siblingOperationKeys, ...newOperationKeys]).size !== expectedUnionCardinality
      ) {
        throw new ForbiddenException('Impersonation operation union cardinality diverged');
      }
      const operationReceiptCount = await operationReceiptRepository.count({
        where: { sessionId: session.id },
      });
      if (operationReceiptCount >= IMPERSONATION_OPERATION_RECEIPT_CAP_PER_SESSION) {
        throw new ServiceUnavailableException(
          'Impersonation operation-receipt capacity is exhausted',
        );
      }
      const decision = denialReason
        ? ImpersonationAuthorizationDecision.DENIED
        : ImpersonationAuthorizationDecision.AUTHORIZED;
      await operationReceiptRepository.save(
        operationReceiptRepository.create({
          sessionId: session.id,
          authorizationReceiptId: request.authorizationReceiptId,
          operationSetDigest,
          operations: operations.map((operation) => ({ ...operation })),
          operationCount: operations.length,
          decision,
          ...(denialReason ? { denialReason } : {}),
          sessionGeneration,
          permissionGeneration,
        }),
      );
      await this.recordRequiredAudit(entityManager, {
        action:
          decision === ImpersonationAuthorizationDecision.AUTHORIZED
            ? 'IMPERSONATION_OPERATIONS_AUTHORIZED'
            : 'IMPERSONATION_OPERATIONS_DENIED',
        entityType: 'ImpersonationAuthorizationReceipt',
        entityId: request.authorizationReceiptId,
        performedBy: request.actorId,
        tenantId: session.targetTenantId,
        sessionId: session.id,
        ipAddress: request.clientIp,
        userAgent: request.clientUserAgent,
        details: {
          authorizationReceiptId: request.authorizationReceiptId,
          requestDigest: computedDigest,
          operationSetDigest,
          operations,
          operationCount: operations.length,
          method: request.method,
          normalizedPath: request.normalizedPath,
          normalizedQueryHash: request.normalizedQueryHash,
          bodyHash: request.bodyHash,
          effectiveTenantId: request.effectiveTenantId,
          decision,
          denialReason,
          sessionGeneration,
          permissionGeneration,
        },
      });
      if (denialReason || !permissions) return null;
      return this.authorizationReceiptResult(request, permissions, session, false);
    });
  }

  private assertAuthorizationRequest(request: AuthorizeImpersonationRequest): {
    readonly tokenHash: string;
    readonly computedDigest: string;
  } {
    if (!isImpersonationCredential(request.credential)) {
      throw new BadRequestException('A canonical impersonation credential is required');
    }
    if (isIP(request.clientIp) === 0) {
      throw new BadRequestException('A canonical client IP is required');
    }
    const coordinate: ImpersonationAuthorizationReceiptCoordinateV1 = {
      schemaVersion: request.schemaVersion,
      authorizationReceiptId: request.authorizationReceiptId,
      sessionId: request.sessionId,
      actorId: request.actorId,
      mfaVerified: request.mfaVerified,
      effectiveTenantId: request.effectiveTenantId,
      method: request.method,
      normalizedPath: request.normalizedPath,
      normalizedQueryHash: request.normalizedQueryHash,
      bodyHash: request.bodyHash,
      clientIp: request.clientIp,
      clientUserAgent: request.clientUserAgent,
    };
    let computedDigest: string;
    try {
      computedDigest = impersonationAuthorizationRequestDigestV1(coordinate);
    } catch {
      throw new BadRequestException('Impersonation authorization coordinate is not canonical');
    }
    if (request.requestDigest !== computedDigest) {
      throw new BadRequestException('Impersonation authorization request digest does not match');
    }
    return { tokenHash: this.hashToken(request.credential), computedDigest };
  }

  private authorizationGenerations(
    session: ImpersonationSession,
    permission: ImpersonationPermission | null,
  ): { readonly sessionGeneration: string; readonly permissionGeneration: string } {
    const sessionGeneration = canonicalWireJsonSha256V1(
      {
        domain: 'aquaculture.impersonation-session-generation',
        schemaVersion: 'impersonation-session-generation/v1',
      },
      {
        id: session.id,
        status: session.status,
        targetTenantId: session.targetTenantId,
        expiresAt: session.expiresAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
        permissions: session.permissions ?? null,
      },
    );
    const permissionGeneration = canonicalWireJsonSha256V1(
      {
        domain: 'aquaculture.impersonation-permission-generation',
        schemaVersion: 'impersonation-permission-generation/v1',
      },
      permission
        ? {
            id: permission.id,
            isActive: permission.isActive,
            canImpersonate: permission.canImpersonate,
            allowedTenants: permission.allowedTenants ?? null,
            restrictedTenants: permission.restrictedTenants ?? null,
            defaultPermissions: permission.defaultPermissions ?? null,
            expiresAt: permission.expiresAt?.toISOString() ?? null,
            updatedAt: permission.updatedAt.toISOString(),
          }
        : { missing: true },
    );
    return { sessionGeneration, permissionGeneration };
  }

  private authorizationDenialReason(
    request: AuthorizeImpersonationRequest,
    session: ImpersonationSession,
    permission: ImpersonationPermission | null,
    permissions: ImpersonationPermissions | undefined,
    grantedPermissions: ImpersonationPermissions | undefined,
    databaseNow: Date,
  ): string | undefined {
    if (request.schemaVersion !== IMPERSONATION_AUTHORIZATION_RECEIPT_VERSION) {
      return 'unsupported_receipt_version';
    }
    if (session.status !== ImpersonationStatus.ACTIVE) return 'session_not_active';
    if (session.expiresAt <= databaseNow) return 'session_expired';
    if (session.superAdminId !== request.actorId) return 'actor_binding_mismatch';
    if (session.targetTenantId !== request.effectiveTenantId) return 'tenant_binding_mismatch';
    if (!session.ipAddress || session.ipAddress !== request.clientIp) return 'ip_binding_mismatch';
    if (!session.userAgent || session.userAgent !== request.clientUserAgent) {
      return 'user_agent_binding_mismatch';
    }
    if (!session.mfaCompleted || request.mfaVerified !== true) return 'mfa_binding_missing';
    if (
      !permission ||
      this.impersonationPermissionDenial(permission, session.targetTenantId, databaseNow)
    ) {
      return 'permission_inactive_or_out_of_scope';
    }
    if (!permissions || !grantedPermissions) return 'invalid_stored_permissions';
    if (
      IMPERSONATION_BOOLEAN_GRANTS.some(
        (grant) => permissions[grant] && !grantedPermissions[grant],
      ) ||
      permissions.allowedModules?.some(
        (module) =>
          grantedPermissions.allowedModules !== undefined &&
          !grantedPermissions.allowedModules.includes(module),
      ) ||
      permissions.allowedModules?.some(
        (module) => grantedPermissions.restrictedModules?.includes(module) === true,
      )
    ) {
      return 'session_permissions_exceed_current_grant';
    }
    return undefined;
  }

  private authorizationReceiptResult(
    request: AuthorizeImpersonationRequest,
    permissions: ImpersonationPermissions,
    session: ImpersonationSession,
    replayed: boolean,
  ): ImpersonationAuthorizationReceiptResult {
    return {
      authorizationReceiptId: request.authorizationReceiptId,
      requestDigest: request.requestDigest,
      replayed,
      context: this.authorizationContext(permissions, session),
    };
  }

  private authorizationContext(
    permissions: ImpersonationPermissions,
    session: ImpersonationSession,
  ): ImpersonationContext {
    return {
      sessionId: session.id,
      superAdminId: session.superAdminId,
      targetTenantId: session.targetTenantId,
      targetUserId: session.targetUserId || undefined,
      permissions,
      expiresAt: session.expiresAt,
      isActive: true,
    };
  }

  // ============================================================================
  // Query & Reports
  // ============================================================================

  async querySessions(params: {
    superAdminId?: string;
    targetTenantId?: string;
    status?: ImpersonationStatus;
    reason?: ImpersonationReason;
    search?: string;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
  }): Promise<IStandardPaginatedResult<SafeImpersonationSession>> {
    const query = this.sessionRepo.createQueryBuilder('s');

    if (params.superAdminId) {
      query.andWhere('s.superAdminId = :superAdminId', { superAdminId: params.superAdminId });
    }
    if (params.targetTenantId) {
      query.andWhere('s.targetTenantId = :targetTenantId', {
        targetTenantId: params.targetTenantId,
      });
    }
    if (params.status) {
      query.andWhere('s.status = :status', { status: params.status });
    }
    if (params.reason) {
      query.andWhere('s.reason = :reason', { reason: params.reason });
    }
    const search = params.search?.trim();
    if (search) {
      query.andWhere('(s.targetTenantName ILIKE :search OR s.superAdminEmail ILIKE :search)', {
        search: `%${search}%`,
      });
    }
    if (params.startDate) {
      query.andWhere('s.createdAt >= :startDate', { startDate: params.startDate });
    }
    if (params.endDate) {
      query.andWhere('s.createdAt <= :endDate', { endDate: params.endDate });
    }

    query.orderBy('s.createdAt', 'DESC').addOrderBy('s.id', 'DESC');

    const page = params.page || 1;
    const limit = params.limit || 20;
    query.skip((page - 1) * limit).take(limit);

    const [items, total] = await query.getManyAndCount();
    // DB-ADMIN-HIGH-002: never serialize the token columns onto a list response.
    return createStandardPaginatedResult(items.map(toSafeImpersonationSession), total, page, limit);
  }

  async getSession(id: string): Promise<SafeImpersonationSession> {
    const session = await this.sessionRepo.findOne({ where: { id } });
    if (!session) {
      throw new NotFoundException(`Session not found: ${id}`);
    }
    // DB-ADMIN-HIGH-002: strip secret token columns before the entity leaves the service.
    return toSafeImpersonationSession(session);
  }

  async getAuditSummary(startDate?: Date, endDate?: Date): Promise<ImpersonationAuditSummary> {
    const databaseNow = await this.databaseNow(this.dataSource.manager);
    const start = startDate ?? new Date(databaseNow.getTime() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ?? databaseNow;

    const [
      totalSessions,
      activeSessions,
      sessionsByReasonRaw,
      topImpersonatorsRaw,
      topTenantsRaw,
      recentSessions,
    ] = await Promise.all([
      this.sessionRepo.count({
        where: { createdAt: LessThan(end) },
      }),
      this.sessionRepo.count({
        where: { status: ImpersonationStatus.ACTIVE, expiresAt: MoreThan(databaseNow) },
      }),
      this.sessionRepo
        .createQueryBuilder('s')
        .select('s.reason', 'reason')
        .addSelect('COUNT(*)', 'count')
        .where('s.createdAt BETWEEN :start AND :end', { start, end })
        .groupBy('s.reason')
        .getRawMany(),
      this.sessionRepo
        .createQueryBuilder('s')
        .select('s.superAdminId', 'adminId')
        .addSelect('s.superAdminEmail', 'email')
        .addSelect('COUNT(*)', 'sessionCount')
        .where('s.createdAt BETWEEN :start AND :end', { start, end })
        .groupBy('s.superAdminId')
        .addGroupBy('s.superAdminEmail')
        .orderBy('COUNT(*)', 'DESC')
        .limit(10)
        .getRawMany(),
      this.sessionRepo
        .createQueryBuilder('s')
        .select('s.targetTenantId', 'tenantId')
        .addSelect('s.targetTenantName', 'tenantName')
        .addSelect('COUNT(*)', 'sessionCount')
        .where('s.createdAt BETWEEN :start AND :end', { start, end })
        .groupBy('s.targetTenantId')
        .addGroupBy('s.targetTenantName')
        .orderBy('COUNT(*)', 'DESC')
        .limit(10)
        .getRawMany(),
      this.sessionRepo.find({
        order: { createdAt: 'DESC' },
        take: 10,
      }),
    ]);

    const sessionsByReason: Record<ImpersonationReason, number> = {
      [ImpersonationReason.SUPPORT_REQUEST]: 0,
      [ImpersonationReason.DEBUGGING]: 0,
      [ImpersonationReason.CONFIGURATION]: 0,
      [ImpersonationReason.ONBOARDING_ASSISTANCE]: 0,
      [ImpersonationReason.SECURITY_INVESTIGATION]: 0,
      [ImpersonationReason.DATA_VERIFICATION]: 0,
      [ImpersonationReason.OTHER]: 0,
    };

    for (const item of sessionsByReasonRaw) {
      sessionsByReason[item.reason as ImpersonationReason] = parseInt(item.count, 10);
    }

    return {
      totalSessions,
      activeSessions,
      sessionsByReason,
      topImpersonators: topImpersonatorsRaw.map((r) => ({
        adminId: r.adminId,
        email: r.email || 'Unknown',
        sessionCount: parseInt(r.sessionCount, 10),
      })),
      topTargetTenants: topTenantsRaw.map((r) => ({
        tenantId: r.tenantId,
        tenantName: r.tenantName || 'Unknown',
        sessionCount: parseInt(r.sessionCount, 10),
      })),
      // DB-ADMIN-HIGH-002: the recent-sessions block must not carry token columns.
      recentSessions: recentSessions.map(toSafeImpersonationSession),
    };
  }

  // ============================================================================
  // Scheduled Tasks
  // ============================================================================

  @Cron(CronExpression.EVERY_MINUTE)
  async expireOldSessions(): Promise<void> {
    const now = await this.databaseNow(this.dataSource.manager);
    const expired = await this.sessionRepo.find({
      where: {
        status: ImpersonationStatus.ACTIVE,
        expiresAt: LessThan(now),
      },
    });

    let expiredCount = 0;
    for (const session of expired) {
      if (await this.expireSession(session.id, now)) expiredCount += 1;
    }

    if (expiredCount > 0) {
      this.logger.log(JSON.stringify({ event: 'impersonation_sessions_expired', expiredCount }));
    }
  }

  private async expireSession(sessionId: string, cutoff: Date): Promise<boolean> {
    return this.dataSource.transaction(async (entityManager) => {
      const session = await this.findLockedSession(entityManager, { id: sessionId });
      if (!session) return false;
      return this.expireLockedSession(entityManager, session, cutoff);
    });
  }

  private async expireLockedSession(
    entityManager: EntityManager,
    session: ImpersonationSession,
    cutoff: Date,
  ): Promise<boolean> {
    if (session.status !== ImpersonationStatus.ACTIVE || session.expiresAt > cutoff) return false;
    session.status = ImpersonationStatus.EXPIRED;
    session.endedAt = cutoff;
    session.endReason = 'Session expired';
    session.impersonationToken = null;

    await this.saveSessionWithRequiredAudit(entityManager, session, (persisted) => ({
      action: 'IMPERSONATION_EXPIRED',
      entityType: 'ImpersonationSession',
      entityId: persisted.id,
      performedBy: 'system:cron',
      tenantId: persisted.targetTenantId,
      sessionId: persisted.id,
      details: {
        sessionId: persisted.id,
        sessionOwnerId: persisted.superAdminId,
        durationActualMinutes:
          persisted.endedAt && persisted.createdAt
            ? Math.round((persisted.endedAt.getTime() - persisted.createdAt.getTime()) / 60000)
            : null,
      },
    }));
    return true;
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private generateSecureToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /** C-5 fix: Hash a token with SHA-256 for secure storage */
  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  // ============================================================================
  // Active Sessions Info
  // ============================================================================

  async getActiveSessions(): Promise<SafeImpersonationSession[]> {
    const databaseNow = await this.databaseNow(this.dataSource.manager);
    const active = await this.sessionRepo.find({
      where: {
        status: ImpersonationStatus.ACTIVE,
        expiresAt: MoreThan(databaseNow),
      },
      order: { createdAt: 'DESC' },
    });
    return active.map(toSafeImpersonationSession);
  }

  async getActiveSessionCount(): Promise<number> {
    const databaseNow = await this.databaseNow(this.dataSource.manager);
    return this.sessionRepo.count({
      where: {
        status: ImpersonationStatus.ACTIVE,
        expiresAt: MoreThan(databaseNow),
      },
    });
  }
}
