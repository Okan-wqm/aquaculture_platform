import * as crypto from 'crypto';

import {
  Injectable,
  Logger,
  Optional,
  OnModuleInit,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { RedisService } from '@aquaculture/backend-common/redis';
import { AuditLogService } from '../../audit/audit.service';
import { AuditSeverity } from '../../audit/audit.entity';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, Between, In } from 'typeorm';

import {
  ImpersonationSession,
  ImpersonationPermission,
  ImpersonationStatus,
  ImpersonationReason,
  ImpersonationPermissions,
  ImpersonationAction,
  SafeImpersonationSession,
  toSafeImpersonationSession,
  IMPERSONATION_MAX_SESSION_MINUTES,
} from '../entities/impersonation-session.entity';
import {
  createStandardPaginatedResult,
  type PaginationResultV1,
} from '@platform/pagination-contracts';

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
  ipAddress?: string;
  userAgent?: string;
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

/** Default audit window when the caller does not name one: the trailing 30 days. */
export const AUDIT_SUMMARY_DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface ImpersonationAuditSummary {
  /**
   * The window every `…InWindow` field below was computed over, echoed back so
   * a caller labels the numbers with the period that actually produced them.
   *
   * The admin panel used to hardcode "(30d)" over an all-time count. A default
   * that lives only inside this method is invisible to the renderer, so the
   * label and the query drift the moment either changes. Returning the window
   * makes that impossible: the label is derived from the same values the
   * aggregates were.
   */
  windowStart: string;
  windowEnd: string;

  /** Sessions CREATED within [windowStart, windowEnd]. */
  totalSessionsInWindow: number;
  /** Sum of actionCount over the sessions created within the window. */
  actionsLoggedInWindow: number;
  sessionsByReasonInWindow: Record<ImpersonationReason, number>;
  topImpersonatorsInWindow: Array<{ adminId: string; email: string; sessionCount: number }>;
  topTargetTenantsInWindow: Array<{ tenantId: string; tenantName: string; sessionCount: number }>;
  /** The most recent sessions WITHIN the window, newest first. */
  recentSessionsInWindow: SafeImpersonationSession[];

  /**
   * Point-in-time, NOT windowed — "how many are live right now". Named apart
   * from the windowed fields because mixing the two vocabularies in one object
   * is what let a 30-day label land on an all-time number.
   */
  activeSessionsNow: number;
  activePermissionsNow: number;
}

// ============================================================================
// Impersonation Service
// ============================================================================

@Injectable()
export class ImpersonationService implements OnModuleInit {
  private readonly logger = new Logger(ImpersonationService.name);
  /** In-memory fallback — single-instance only */
  private localActiveSessions: Map<string, ImpersonationSession> = new Map();
  private readonly TOKEN_EXPIRY_BUFFER_MS = 60000; // 1 minute

  // SECURITY: Rate limiting for impersonation attempts
  private static readonly RATE_LIMIT_MAX_ATTEMPTS = 5;
  private static readonly RATE_LIMIT_WINDOW_SECONDS = 300; // 5 minutes
  private readonly useRedis: boolean;

  /** In-memory fallback — single-instance only, not distributed */
  private readonly localRateLimitMap: Map<string, { count: number; resetAt: number }> = new Map();

  constructor(
    @InjectRepository(ImpersonationSession)
    private readonly sessionRepo: Repository<ImpersonationSession>,
    @InjectRepository(ImpersonationPermission)
    private readonly permissionRepo: Repository<ImpersonationPermission>,
    private readonly auditLogService: AuditLogService,
    @Optional() private readonly redisService?: RedisService,
  ) {
    this.useRedis = !!this.redisService;
    if (!this.useRedis) {
      this.logger.warn(
        'Impersonation rate limiting using in-memory Map — NOT distributed. ' +
        'Multi-instance deployments bypass rate limits.',
      );
    }
    // Clean up in-memory rate limit map periodically (no-op when using Redis).
    // This is synchronous setup and stays in the constructor; the async
    // session warm-up moved to onModuleInit so its promise is awaited rather
    // than floated out of the constructor (no-floating-promises).
    if (!this.useRedis) {
      // unref: this is housekeeping for an in-memory fallback map, so it must
      // never be the reason the process stays alive. Without it the timer keeps
      // the event loop open forever — Node will not exit, and a Jest run whose
      // only suite instantiates this service hangs at 100% instead of
      // reporting.
      setInterval(() => this.cleanupRateLimitMap(), 60000).unref();
    }
  }

  /**
   * Warm the in-memory active-session cache from persistence. Runs once at
   * module init — async work does not belong in the constructor, where its
   * promise would be unawaited (the rejected-promise + ordering hazard
   * no-floating-promises guards against). Nest awaits this hook before the
   * service is considered ready.
   */
  async onModuleInit(): Promise<void> {
    await this.loadActiveSessions();
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
  private async checkRateLimitRedis(key: string): Promise<{ allowed: boolean; retryAfterMs?: number }> {
    const redisKey = `impersonate:ratelimit:${key}`;
    const count = await this.redisService!.incr(redisKey);

    // Set TTL only on first increment
    if (count === 1) {
      await this.redisService!.expire(redisKey, ImpersonationService.RATE_LIMIT_WINDOW_SECONDS);
    }

    if (count > ImpersonationService.RATE_LIMIT_MAX_ATTEMPTS) {
      // WHY: We read the remaining TTL from Redis to give an accurate retry-after value
      const ttlRemaining = await this.redisService!.ttl(redisKey);
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

  private async loadActiveSessions(): Promise<void> {
    const active = await this.sessionRepo.find({
      where: { status: ImpersonationStatus.ACTIVE },
    });
    for (const session of active) {
      this.localActiveSessions.set(session.id, session);
    }
    this.logger.log(`Loaded ${active.length} active impersonation sessions`);
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
    // Check if permission already exists
    let permission = await this.permissionRepo.findOne({
      where: { superAdminId: data.superAdminId },
    });

    if (permission) {
      // Update existing permission
      Object.assign(permission, {
        ...data,
        isActive: true,
        grantedAt: new Date(),
      });
      // RBAC-MEDIUM-009: the update path spreads caller data — clamp the
      // duration ceiling here exactly like the create path.
      if (permission.maxSessionDurationMinutes > IMPERSONATION_MAX_SESSION_MINUTES) {
        permission.maxSessionDurationMinutes = IMPERSONATION_MAX_SESSION_MINUTES;
      }
    } else {
      permission = this.permissionRepo.create({
        ...data,
        canImpersonate: true,
        isActive: true,
        // RBAC-MEDIUM-009: clamp to the policy ceiling even if the DTO layer
        // is bypassed (internal callers) — the cap is enforced at every layer.
        maxSessionDurationMinutes: Math.min(
          data.maxSessionDurationMinutes || IMPERSONATION_MAX_SESSION_MINUTES,
          IMPERSONATION_MAX_SESSION_MINUTES,
        ),
        maxConcurrentSessions: data.maxConcurrentSessions || 3,
        requireReason: data.requireReason ?? true,
        requireTicketReference: data.requireTicketReference ?? false,
        // LOW-003 fix: default to false since notification is not yet implemented
        notifyTenantAdmin: data.notifyTenantAdmin ?? false,
        grantedAt: new Date(),
      });
    }

    const saved = await this.permissionRepo.save(permission);
    this.logger.log(`Granted impersonation permission to: ${data.superAdminId}`);
    return saved;
  }

  async revokeImpersonationPermission(superAdminId: string): Promise<void> {
    const permission = await this.permissionRepo.findOne({ where: { superAdminId } });
    if (!permission) {
      throw new NotFoundException(`Permission not found for admin: ${superAdminId}`);
    }

    permission.isActive = false;
    permission.canImpersonate = false;
    await this.permissionRepo.save(permission);

    // End all active sessions for this admin
    await this.endAllSessionsForAdmin(superAdminId, 'Permission revoked');

    this.logger.log(`Revoked impersonation permission for: ${superAdminId}`);
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
  }): Promise<PaginationResultV1<ImpersonationPermission>> {
    const query = this.permissionRepo.createQueryBuilder('p');

    if (params.tenantId) {
      query.andWhere(':tenantId = ANY(p.allowedTenants)', { tenantId: params.tenantId });
    }
    if (params.isActive !== undefined) {
      query.andWhere('p.isActive = :isActive', { isActive: params.isActive });
    }

    query.orderBy('p.grantedAt', 'DESC');

    const page = params.page || 1;
    const limit = params.limit || 20;
    query.skip((page - 1) * limit).take(limit);

    const [data, total] = await query.getManyAndCount();
    return createStandardPaginatedResult<ImpersonationPermission>(data, total, page, limit);
  }

  async canImpersonate(superAdminId: string, targetTenantId: string): Promise<{
    allowed: boolean;
    reason?: string;
    permission?: ImpersonationPermission;
  }> {
    const permission = await this.getImpersonationPermission(superAdminId);

    if (!permission) {
      return { allowed: false, reason: 'No impersonation permission granted' };
    }

    if (!permission.canImpersonate) {
      return { allowed: false, reason: 'Impersonation permission disabled' };
    }

    if (permission.expiresAt && permission.expiresAt < new Date()) {
      return { allowed: false, reason: 'Impersonation permission expired' };
    }

    // Check tenant restrictions
    if (permission.restrictedTenants?.includes(targetTenantId)) {
      return { allowed: false, reason: 'Tenant is restricted for impersonation' };
    }

    // Security: Fail-closed if allowedTenants is empty/undefined
    // Impersonation must have explicit tenant whitelist
    if (!permission.allowedTenants || permission.allowedTenants.length === 0) {
      return { allowed: false, reason: 'No allowed tenants configured - impersonation denied' };
    }

    if (!permission.allowedTenants.includes(targetTenantId)) {
      return { allowed: false, reason: 'Tenant not in allowed list' };
    }

    // Check concurrent session limit
    const activeSessions = await this.sessionRepo.count({
      where: { superAdminId, status: ImpersonationStatus.ACTIVE },
    });

    if (activeSessions >= permission.maxConcurrentSessions) {
      return { allowed: false, reason: 'Maximum concurrent sessions reached' };
    }

    return { allowed: true, permission };
  }

  // ============================================================================
  // Session Management
  // ============================================================================

  async startImpersonation(
    request: StartImpersonationRequest,
  ): Promise<StartedImpersonationSession> {
    // SECURITY: Rate limiting based on admin ID and IP address
    const rateLimitKey = `impersonate:${request.superAdminId}:${request.ipAddress || 'unknown'}`;
    const rateCheck = await this.checkRateLimit(rateLimitKey);

    if (!rateCheck.allowed) {
      const retryAfterSeconds = Math.ceil((rateCheck.retryAfterMs || 0) / 1000);
      this.logger.warn(
        `Rate limit exceeded for impersonation: admin=${request.superAdminId}, ip=${request.ipAddress}`,
      );
      throw new ForbiddenException(
        `Too many impersonation attempts. Please try again in ${retryAfterSeconds} seconds.`,
      );
    }

    // SECURITY: Log all impersonation attempts for audit
    this.logger.log(
      `Impersonation attempt: admin=${request.superAdminEmail} (${request.superAdminId}), ` +
      `target=${request.targetTenantId}, ip=${request.ipAddress || 'unknown'}, ` +
      `reason=${request.reason}`,
    );

    // Validate permission
    const { allowed, reason, permission } = await this.canImpersonate(
      request.superAdminId,
      request.targetTenantId,
    );

    if (!allowed) {
      throw new ForbiddenException(reason);
    }

    // Validate reason requirement
    if (permission?.requireReason && !request.reason) {
      throw new BadRequestException('Reason is required for impersonation');
    }

    if (permission?.requireTicketReference && !request.ticketReference) {
      throw new BadRequestException('Ticket reference is required for impersonation');
    }

    // Calculate expiration. RBAC-MEDIUM-009: the absolute policy cap is the
    // final term — a HISTORICAL grant row stored before the cap existed (up
    // to 1440 min) can never confer a session longer than the ceiling.
    const durationMinutes = Math.min(
      request.durationMinutes || IMPERSONATION_MAX_SESSION_MINUTES,
      permission?.maxSessionDurationMinutes || IMPERSONATION_MAX_SESSION_MINUTES,
      IMPERSONATION_MAX_SESSION_MINUTES,
    );
    const expiresAt = new Date(Date.now() + durationMinutes * 60000);

    // Generate secure tokens
    const originalSessionToken = this.generateSecureToken();
    const rawImpersonationToken = this.generateSecureToken();
    // C-5 fix: store SHA-256 hash of impersonation token, not plaintext
    const impersonationToken = this.hashToken(rawImpersonationToken);

    // Merge permissions
    const defaultPerms: ImpersonationPermissions = {
      canViewData: true,
      canModifyData: false,
      canAccessSettings: false,
      canManageUsers: false,
      canViewBilling: false,
      canExportData: false,
    };

    // SECURITY FIX: Request permissions can only RESTRICT, not EXPAND capabilities
    // Admin-granted permissions (permission.defaultPermissions) define the maximum
    // Client request can only request a subset of what's allowed
    const grantedPerms = permission?.defaultPermissions || defaultPerms;

    // For each permission, take the most restrictive value:
    // - Only allow if granted by admin permission AND requested by client (or use granted default)
    const permissions: ImpersonationPermissions = {
      canViewData: grantedPerms.canViewData && (request.permissions?.canViewData ?? grantedPerms.canViewData),
      canModifyData: grantedPerms.canModifyData && (request.permissions?.canModifyData ?? false),
      canAccessSettings: grantedPerms.canAccessSettings && (request.permissions?.canAccessSettings ?? false),
      canManageUsers: grantedPerms.canManageUsers && (request.permissions?.canManageUsers ?? false),
      canViewBilling: grantedPerms.canViewBilling && (request.permissions?.canViewBilling ?? false),
      canExportData: grantedPerms.canExportData && (request.permissions?.canExportData ?? false),
    };

    // Create session
    const session = this.sessionRepo.create({
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
      originalSessionToken,
      impersonationToken,
      expiresAt,
      actionsPerformed: [],
      accessedResources: [],
      actionCount: 0,
    });

    const saved = await this.sessionRepo.save(session);
    this.localActiveSessions.set(saved.id, saved);

    // Notify tenant admin if configured
    if (permission?.notifyTenantAdmin) {
      await this.notifyTenantAdmin(saved);
    }

    this.logger.log(
      `Started impersonation: ${request.superAdminEmail} -> ${request.targetTenantName || request.targetTenantId}`,
    );

    // AUDITTRAIL-CRITICAL-003 cure: SUPER_ADMIN cross-tenant access has
    // the highest audit-criticality of any platform action. The
    // pre-fix `.catch(() => warn)` pattern was fire-and-forget — under
    // a transient DB blip the session existed in the impersonation
    // table but was invisible in audit.audit_logs, breaking the
    // SOC 2 CC1 / GDPR Art 30 reconstruction guarantee. Awaiting the
    // log lets a failure propagate; the operator gets a clear error
    // instead of a half-recorded SUPER_ADMIN session.
    await this.auditLogService.log({
      action: 'IMPERSONATION_STARTED',
      entityType: 'ImpersonationSession',
      entityId: saved.id,
      performedBy: request.superAdminId,
      tenantId: request.targetTenantId,
      ipAddress: request.ipAddress,
      details: {
        sessionId: saved.id,
        targetTenantId: request.targetTenantId,
        targetUserId: request.targetUserId,
        reason: request.reason,
        reasonDetails: request.reasonDetails,
        ticketReference: request.ticketReference,
        durationMinutes,
      },
    });

    // C-5 fix: Return raw token to caller (only time it's available in plaintext).
    // DB-ADMIN-HIGH-002: strip the stored secrets (plaintext originalSessionToken
    // + token hash) from the response and re-attach ONLY the raw impersonation
    // token the initiator needs — so the create response reveals exactly the
    // one credential, once, and never echoes the stored plaintext session token.
    return { ...toSafeImpersonationSession(saved), impersonationToken: rawImpersonationToken };
  }

  async endImpersonation(
    sessionId: string,
    endReason?: string,
    endedBy?: string,
  ): Promise<SafeImpersonationSession> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException(`Session not found: ${sessionId}`);
    }

    if (session.status !== ImpersonationStatus.ACTIVE) {
      throw new BadRequestException(`Session is not active: ${session.status}`);
    }

    // H26 fix: Session ownership check -- only the admin who started the session can end it
    if (endedBy && session.superAdminId !== endedBy) {
      throw new ForbiddenException('Bu oturumu sonlandırma yetkiniz yok');
    }

    session.status = ImpersonationStatus.ENDED;
    session.endedAt = new Date();
    session.endReason = endReason || (endedBy ? 'Ended by user' : 'Manual termination');

    const saved = await this.sessionRepo.save(session);
    this.localActiveSessions.delete(sessionId);

    // AUDITTRAIL-CRITICAL-003 cure: end-event audit row pairs with the
    // start-event row at impersonation start. Operators querying the
    // SUPER_ADMIN access pattern can reconstruct the (session-start,
    // session-end) timeline from audit.audit_logs alone, without
    // joining the impersonation_sessions table (which is operational,
    // not audit, and may be retention-bound differently).
    await this.auditLogService.log({
      action: 'IMPERSONATION_ENDED',
      entityType: 'ImpersonationSession',
      entityId: saved.id,
      performedBy: endedBy || session.superAdminId,
      tenantId: session.targetTenantId,
      details: {
        sessionId: saved.id,
        endReason: saved.endReason,
        durationActualMinutes:
          saved.endedAt && session.createdAt
            ? Math.round((saved.endedAt.getTime() - session.createdAt.getTime()) / 60000)
            : null,
      },
    });

    this.logger.log(`Ended impersonation session: ${sessionId}`);

    // DB-ADMIN-HIGH-002: the end response is session state, not a credential
    // channel — strip the stored token columns like every other response path.
    return toSafeImpersonationSession(saved);
  }

  async terminateSession(
    sessionId: string,
    terminatedBy: string,
    reason: string,
  ): Promise<SafeImpersonationSession> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException(`Session not found: ${sessionId}`);
    }

    session.status = ImpersonationStatus.TERMINATED;
    session.endedAt = new Date();
    session.endReason = `Terminated by ${terminatedBy}: ${reason}`;

    const saved = await this.sessionRepo.save(session);
    this.localActiveSessions.delete(sessionId);

    // AUDITTRAIL-CRITICAL-003 cure: terminated-by-other-admin event
    // is a stronger security signal than self-end (it indicates an
    // operator override of an active SUPER_ADMIN session). CRITICAL
    // severity so the audit dashboard surfaces it.
    await this.auditLogService.log({
      action: 'IMPERSONATION_TERMINATED',
      entityType: 'ImpersonationSession',
      entityId: saved.id,
      performedBy: terminatedBy,
      tenantId: session.targetTenantId,
      severity: AuditSeverity.CRITICAL,
      details: {
        sessionId: saved.id,
        sessionOwnerId: session.superAdminId,
        endReason: saved.endReason,
        terminationReason: reason,
      },
    });

    this.logger.warn(`Terminated impersonation session: ${sessionId} - ${reason}`);

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
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException(`Session not found: ${sessionId}`);
    }

    if (session.status !== ImpersonationStatus.ACTIVE) {
      throw new BadRequestException(`Session is not active: ${session.status}`);
    }

    // Session ownership check -- only the admin who started the session can extend it
    if (session.superAdminId !== extendedBy) {
      throw new ForbiddenException('Bu oturumu uzatma yetkiniz yok');
    }

    // Check permission to validate max session duration
    const permission = await this.permissionRepo.findOne({
      where: { superAdminId: session.superAdminId, isActive: true },
    });

    // RBAC-MEDIUM-009: total duration is bounded by the policy ceiling too —
    // a historical over-cap grant cannot be laundered through extensions.
    const maxDurationMinutes = Math.min(
      permission?.maxSessionDurationMinutes || IMPERSONATION_MAX_SESSION_MINUTES,
      IMPERSONATION_MAX_SESSION_MINUTES,
    );
    const sessionStartTime = session.createdAt.getTime();
    const currentExpiresAt = session.expiresAt.getTime();
    const newExpiresAt = currentExpiresAt + additionalMinutes * 60000;
    const totalDurationMinutes = (newExpiresAt - sessionStartTime) / 60000;

    if (totalDurationMinutes > maxDurationMinutes) {
      throw new BadRequestException(
        `Toplam oturum suresi maksimum ${maxDurationMinutes} dakikayi asamaz`,
      );
    }

    session.expiresAt = new Date(newExpiresAt);

    // Log the extension as an action
    const actions = session.actionsPerformed || [];
    actions.push({
      action: 'session_extended',
      resource: 'impersonation_session',
      resourceId: sessionId,
      timestamp: new Date().toISOString(),
      details: {
        additionalMinutes,
        newExpiresAt: session.expiresAt.toISOString(),
        extendedBy,
      },
    });
    session.actionsPerformed = actions;
    session.actionCount = (session.actionCount || 0) + 1;

    const saved = await this.sessionRepo.save(session);

    // Update in-memory cache
    this.localActiveSessions.set(sessionId, saved);

    // AUDITTRAIL-CRITICAL-003 cure: extension event audit row. Each
    // extension is a discrete audit event (operator chose to extend
    // SUPER_ADMIN access) — captured in audit.audit_logs separately
    // from the session.actionsPerformed array (which is operational
    // metadata on the session itself, not a regulatory audit record).
    await this.auditLogService.log({
      action: 'IMPERSONATION_EXTENDED',
      entityType: 'ImpersonationSession',
      entityId: saved.id,
      performedBy: extendedBy,
      tenantId: session.targetTenantId,
      details: {
        sessionId: saved.id,
        additionalMinutes,
        newExpiresAt: saved.expiresAt.toISOString(),
        sessionOwnerId: session.superAdminId,
      },
    });

    this.logger.log(
      `Extended impersonation session ${sessionId} by ${additionalMinutes} minutes`,
    );

    // DB-ADMIN-HIGH-002: never echo the stored token columns on the extend response.
    return toSafeImpersonationSession(saved);
  }

  private async endAllSessionsForAdmin(adminId: string, reason: string): Promise<void> {
    const sessions = await this.sessionRepo.find({
      where: { superAdminId: adminId, status: ImpersonationStatus.ACTIVE },
    });

    for (const session of sessions) {
      await this.endImpersonation(session.id, reason);
    }
  }

  // ============================================================================
  // Session Validation
  // ============================================================================

  /**
   * Validate an impersonation session token.
   *
   * SECURITY (ADMIN-MEDIUM-001): When `requestIp` is provided, the session's
   * bound IP is checked. A stolen impersonation token used from a different
   * IP is rejected -- the attacker would need both the token AND access from
   * the original admin's IP.
   *
   * @param token - Raw impersonation token (will be hashed for DB lookup)
   * @param requestIp - Optional IP of the current request for IP binding validation
   */
  async validateSession(token: string, requestIp?: string): Promise<ImpersonationContext | null> {
    // C-5 fix: compare by hash since we store SHA-256(token) in DB
    const tokenHash = this.hashToken(token);
    const session = await this.sessionRepo.findOne({
      where: { impersonationToken: tokenHash, status: ImpersonationStatus.ACTIVE },
    });

    if (!session) {
      return null;
    }

    // Check expiration
    if (session.expiresAt < new Date()) {
      await this.expireSession(session);
      return null;
    }

    // SECURITY (ADMIN-MEDIUM-001): IP binding validation.
    // If the session was created with an IP address, every subsequent request
    // MUST originate from the same IP. This prevents a stolen impersonation
    // token from being usable from a different network location.
    if (requestIp && session.ipAddress && session.ipAddress !== requestIp) {
      this.logger.warn(
        `SECURITY: Impersonation session ${session.id} IP mismatch: ` +
        `bound=${session.ipAddress}, request=${requestIp}. Token rejected.`,
      );
      return null;
    }

    return {
      sessionId: session.id,
      superAdminId: session.superAdminId,
      targetTenantId: session.targetTenantId,
      targetUserId: session.targetUserId || undefined,
      permissions: session.permissions || {
        canViewData: true,
        canModifyData: false,
        canAccessSettings: false,
        canManageUsers: false,
        canViewBilling: false,
        canExportData: false,
      },
      expiresAt: session.expiresAt,
      isActive: true,
    };
  }

  async getActiveSession(sessionId: string): Promise<ImpersonationSession | null> {
    return this.localActiveSessions.get(sessionId) || null;
  }

  async getSessionByToken(token: string): Promise<ImpersonationSession | null> {
    // C-5 fix: compare by hash
    const tokenHash = this.hashToken(token);
    return this.sessionRepo.findOne({
      where: { impersonationToken: tokenHash },
    });
  }

  // ============================================================================
  // Action Logging
  // ============================================================================

  async logAction(
    sessionId: string,
    action: string,
    resource: string,
    resourceId?: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session || session.status !== ImpersonationStatus.ACTIVE) {
      return;
    }

    const actionEntry: ImpersonationAction = {
      action,
      resource,
      resourceId,
      timestamp: new Date().toISOString(),
      details,
    };

    const actions = session.actionsPerformed || [];
    actions.push(actionEntry);

    // Keep last 1000 actions
    if (actions.length > 1000) {
      actions.shift();
    }

    session.actionsPerformed = actions;
    session.actionCount = (session.actionCount || 0) + 1;

    await this.sessionRepo.save(session);

    // Update cache
    this.localActiveSessions.set(sessionId, session);
  }

  async logResourceAccess(
    sessionId: string,
    resourceType: string,
    resourceId: string,
    action: string,
  ): Promise<void> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session || session.status !== ImpersonationStatus.ACTIVE) {
      return;
    }

    const accessed = session.accessedResources || [];
    accessed.push({
      type: resourceType,
      id: resourceId,
      action,
      timestamp: new Date().toISOString(),
    });

    // Keep last 500 accessed resources
    if (accessed.length > 500) {
      accessed.shift();
    }

    session.accessedResources = accessed;
    await this.sessionRepo.save(session);
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
  }): Promise<PaginationResultV1<SafeImpersonationSession>> {
    const query = this.sessionRepo.createQueryBuilder('s');

    if (params.superAdminId) {
      query.andWhere('s.superAdminId = :superAdminId', { superAdminId: params.superAdminId });
    }
    if (params.targetTenantId) {
      query.andWhere('s.targetTenantId = :targetTenantId', { targetTenantId: params.targetTenantId });
    }
    if (params.status) {
      query.andWhere('s.status = :status', { status: params.status });
    }
    if (params.reason) {
      query.andWhere('s.reason = :reason', { reason: params.reason });
    }
    if (params.search) {
      // Both columns are nullable, so ILIKE alone would drop rows whose other
      // column matches; the OR is over the two the admin panel searches on.
      query.andWhere(
        '(s.targetTenantName ILIKE :search OR s.superAdminEmail ILIKE :search)',
        { search: `%${params.search}%` },
      );
    }
    if (params.startDate) {
      query.andWhere('s.createdAt >= :startDate', { startDate: params.startDate });
    }
    if (params.endDate) {
      query.andWhere('s.createdAt <= :endDate', { endDate: params.endDate });
    }

    query.orderBy('s.createdAt', 'DESC');

    const page = params.page || 1;
    const limit = params.limit || 20;
    query.skip((page - 1) * limit).take(limit);

    const [items, total] = await query.getManyAndCount();
    // DB-ADMIN-HIGH-002: never serialize the token columns onto a list response.
    return createStandardPaginatedResult<SafeImpersonationSession>(
      items.map(toSafeImpersonationSession),
      total,
      page,
      limit,
    );
  }

  async getSession(id: string): Promise<SafeImpersonationSession> {
    const session = await this.sessionRepo.findOne({ where: { id } });
    if (!session) {
      throw new NotFoundException(`Session not found: ${id}`);
    }
    // DB-ADMIN-HIGH-002: strip secret token columns before the entity leaves the service.
    return toSafeImpersonationSession(session);
  }

  async getAuditSummary(
    startDate?: Date,
    endDate?: Date,
  ): Promise<ImpersonationAuditSummary> {
    const start = startDate || new Date(Date.now() - AUDIT_SUMMARY_DEFAULT_WINDOW_MS);
    const end = endDate || new Date();

    const [
      totalSessionsInWindow,
      activeSessionsNow,
      activePermissionsNow,
      actionsRaw,
      sessionsByReasonRaw,
      topImpersonatorsRaw,
      topTenantsRaw,
      recentSessions,
    ] = await Promise.all([
        // Windowed at BOTH ends. This counted `createdAt < end` alone, so it
        // reported every session ever created while every sibling aggregate
        // honoured `start` — the one number the admin panel put a "(30d)"
        // label on was the one number that was not windowed.
        this.sessionRepo.count({
          where: { createdAt: Between(start, end) },
        }),
        this.sessionRepo.count({
          where: { status: ImpersonationStatus.ACTIVE },
        }),
        this.permissionRepo.count({ where: { isActive: true } }),
        this.sessionRepo
          .createQueryBuilder('s')
          .select('COALESCE(SUM(s.actionCount), 0)', 'actions')
          .where('s.createdAt BETWEEN :start AND :end', { start, end })
          .getRawOne<{ actions: string }>(),
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
          // Windowed like every other aggregate here — a "recent" list that
          // ignores the window silently mixes periods inside one response.
          where: { createdAt: Between(start, end) },
          order: { createdAt: 'DESC' },
          take: 10,
        }),
      ]);

    const sessionsByReasonInWindow: Record<ImpersonationReason, number> = {
      [ImpersonationReason.SUPPORT_REQUEST]: 0,
      [ImpersonationReason.DEBUGGING]: 0,
      [ImpersonationReason.CONFIGURATION]: 0,
      [ImpersonationReason.ONBOARDING_ASSISTANCE]: 0,
      [ImpersonationReason.SECURITY_INVESTIGATION]: 0,
      [ImpersonationReason.DATA_VERIFICATION]: 0,
      [ImpersonationReason.OTHER]: 0,
    };

    for (const item of sessionsByReasonRaw) {
      sessionsByReasonInWindow[item.reason as ImpersonationReason] = parseInt(item.count, 10);
    }

    return {
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      totalSessionsInWindow,
      actionsLoggedInWindow: parseInt(actionsRaw?.actions ?? '0', 10),
      activeSessionsNow,
      activePermissionsNow,
      sessionsByReasonInWindow,
      topImpersonatorsInWindow: topImpersonatorsRaw.map((r) => ({
        adminId: r.adminId,
        email: r.email || 'Unknown',
        sessionCount: parseInt(r.sessionCount, 10),
      })),
      topTargetTenantsInWindow: topTenantsRaw.map((r) => ({
        tenantId: r.tenantId,
        tenantName: r.tenantName || 'Unknown',
        sessionCount: parseInt(r.sessionCount, 10),
      })),
      // DB-ADMIN-HIGH-002: the recent-sessions block must not carry token columns.
      recentSessionsInWindow: recentSessions.map(toSafeImpersonationSession),
    };
  }

  // ============================================================================
  // Scheduled Tasks
  // ============================================================================

  @Cron(CronExpression.EVERY_MINUTE)
  async expireOldSessions(): Promise<void> {
    const now = new Date();
    const expired = await this.sessionRepo.find({
      where: {
        status: ImpersonationStatus.ACTIVE,
        expiresAt: LessThan(now),
      },
    });

    for (const session of expired) {
      await this.expireSession(session);
    }

    if (expired.length > 0) {
      this.logger.log(`Expired ${expired.length} impersonation sessions`);
    }
  }

  private async expireSession(session: ImpersonationSession): Promise<void> {
    session.status = ImpersonationStatus.EXPIRED;
    session.endedAt = new Date();
    session.endReason = 'Session expired';

    await this.sessionRepo.save(session);
    this.localActiveSessions.delete(session.id);

    // AUDITTRAIL-CRITICAL-003 cure: expiry event audit row. Even
    // automatic system-driven expiry needs an audit record so the
    // SUPER_ADMIN access timeline is complete in audit.audit_logs.
    // performedBy is the system marker since no operator action drove
    // the expiry; the original session.superAdminId carries the actor
    // identity in details for traceability.
    await this.auditLogService.log({
      action: 'IMPERSONATION_EXPIRED',
      entityType: 'ImpersonationSession',
      entityId: session.id,
      performedBy: 'system:cron',
      tenantId: session.targetTenantId,
      details: {
        sessionId: session.id,
        sessionOwnerId: session.superAdminId,
        durationActualMinutes:
          session.endedAt && session.createdAt
            ? Math.round((session.endedAt.getTime() - session.createdAt.getTime()) / 60000)
            : null,
      },
    });
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

  private async notifyTenantAdmin(session: ImpersonationSession): Promise<void> {
    // In production, this would send email/notification to tenant admin
    this.logger.log(
      `[Notification] Impersonation started for tenant ${session.targetTenantName || session.targetTenantId} by ${session.superAdminEmail}`,
    );
  }

  // ============================================================================
  // Active Sessions Info
  // ============================================================================

  getActiveSessions(): SafeImpersonationSession[] {
    // LOW-005 fix: filter out sessions that have expired in-memory before returning,
    // so callers are not misled by stale session entries after restart or clock drift.
    const now = new Date();
    const active: SafeImpersonationSession[] = [];
    for (const [sessionId, session] of this.localActiveSessions.entries()) {
      if (new Date(session.expiresAt) <= now) {
        // Evict expired sessions from cache on access to prevent stale reads
        this.localActiveSessions.delete(sessionId);
      } else {
        // DB-ADMIN-HIGH-002: strip secret token columns before returning.
        active.push(toSafeImpersonationSession(session));
      }
    }
    return active;
  }

  getActiveSessionCount(): number {
    // LOW-005 fix: return accurate count by evicting expired sessions first
    return this.getActiveSessions().length;
  }
}
