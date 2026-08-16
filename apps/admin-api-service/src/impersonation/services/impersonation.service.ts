import * as crypto from 'crypto';

import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import type {
  AdminImpersonationActionV1,
  AdminImpersonationPermissionV1,
  AdminImpersonationSessionScopeV1,
  AdminImpersonationStatsV1,
  AdminStartedImpersonationSessionV1,
} from '@platform/admin-http-contracts';
import {
  createStandardPaginatedResult,
  type IStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';
import { UUID_REGEX } from '@aquaculture/backend-common/constants';
import { AuditLogService } from '../../audit/audit.service';
import { AuditSeverity } from '../../audit/audit.entity';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, LessThan, MoreThan, Repository } from 'typeorm';

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
  IMPERSONATION_MAX_CONCURRENT_SESSIONS,
  toAdminImpersonationPermissionV1,
} from '../entities/impersonation-session.entity';

/**
 * Start-impersonation response: the safe session view PLUS the raw
 * impersonation token, revealed exactly once to the initiating super-admin so
 * they can drive the session. Never carries `originalSessionToken`.
 */
export type StartedImpersonationSession = AdminStartedImpersonationSessionV1;

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

export interface ImpersonationAuditSummary {
  totalSessions: number;
  activeSessions: number;
  sessionsByReason: Record<ImpersonationReason, number>;
  topImpersonators: Array<{ adminId: string; email: string; sessionCount: number }>;
  topTargetTenants: Array<{ tenantId: string; tenantName: string; sessionCount: number }>;
  recentSessions: SafeImpersonationSession[];
}

// ============================================================================
// Impersonation Service
// ============================================================================

@Injectable()
export class ImpersonationService {
  private readonly logger = new Logger(ImpersonationService.name);

  constructor(
    @InjectRepository(ImpersonationSession)
    private readonly sessionRepo: Repository<ImpersonationSession>,
    @InjectRepository(ImpersonationPermission)
    private readonly permissionRepo: Repository<ImpersonationPermission>,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ============================================================================
  // Permission Management
  // ============================================================================

  async grantImpersonationPermission(data: {
    superAdminId: string;
    superAdminEmail?: string;
    allowedTenants: readonly string[];
    restrictedTenants?: string[];
    defaultPermissions?: ImpersonationPermissions;
    maxSessionDurationMinutes?: number;
    maxConcurrentSessions?: number;
    requireReason?: boolean;
    requireTicketReference?: boolean;
    grantedBy: string;
    expiresAt?: Date;
    notes?: string;
  }): Promise<AdminImpersonationPermissionV1> {
    if (data.allowedTenants.length === 0) {
      throw new BadRequestException('At least one allowed tenant is required');
    }
    const allowedTenants = new Set(data.allowedTenants);
    if (allowedTenants.size !== data.allowedTenants.length) {
      throw new BadRequestException('Allowed tenants must not contain duplicates');
    }
    if ([...allowedTenants].some((tenantId) => !UUID_REGEX.test(tenantId))) {
      throw new BadRequestException('Allowed tenants must contain valid UUIDs');
    }
    const restrictedTenants = new Set(data.restrictedTenants ?? []);
    if (restrictedTenants.size !== (data.restrictedTenants?.length ?? 0)) {
      throw new BadRequestException('Restricted tenants must not contain duplicates');
    }
    if ([...restrictedTenants].some((tenantId) => !UUID_REGEX.test(tenantId))) {
      throw new BadRequestException('Restricted tenants must contain valid UUIDs');
    }
    if ([...restrictedTenants].some((tenantId) => allowedTenants.has(tenantId))) {
      throw new BadRequestException('A tenant cannot be both allowed and restricted');
    }
    if (
      data.maxSessionDurationMinutes !== undefined &&
      (!Number.isInteger(data.maxSessionDurationMinutes) || data.maxSessionDurationMinutes < 1)
    ) {
      throw new BadRequestException('Session duration must be a positive integer');
    }
    if (
      data.maxConcurrentSessions !== undefined &&
      (!Number.isInteger(data.maxConcurrentSessions) || data.maxConcurrentSessions < 1)
    ) {
      throw new BadRequestException('Concurrent session limit must be a positive integer');
    }

    const saved = await this.permissionRepo.manager.transaction(async (manager) => {
      const repository = manager.withRepository(this.permissionRepo);
      let permission = await repository.findOne({
        where: { superAdminId: data.superAdminId },
        lock: { mode: 'pessimistic_write' },
      });
      const action = permission
        ? 'IMPERSONATION_PERMISSION_REGRANTED'
        : 'IMPERSONATION_PERMISSION_GRANTED';
      const grantedAt = new Date();
      const maxSessionDurationMinutes = Math.min(
        data.maxSessionDurationMinutes ?? IMPERSONATION_MAX_SESSION_MINUTES,
        IMPERSONATION_MAX_SESSION_MINUTES,
      );

      if (permission) {
        permission.superAdminEmail = data.superAdminEmail;
        permission.allowedTenants = [...data.allowedTenants];
        permission.restrictedTenants = data.restrictedTenants
          ? [...data.restrictedTenants]
          : undefined;
        permission.defaultPermissions = data.defaultPermissions
          ? { ...data.defaultPermissions }
          : undefined;
        permission.maxSessionDurationMinutes = maxSessionDurationMinutes;
        permission.maxConcurrentSessions = Math.min(
          data.maxConcurrentSessions ?? 3,
          IMPERSONATION_MAX_CONCURRENT_SESSIONS,
        );
        permission.requireReason = data.requireReason ?? true;
        permission.requireTicketReference = data.requireTicketReference ?? false;
        permission.expiresAt = data.expiresAt;
        permission.notes = data.notes;
        permission.grantedBy = data.grantedBy;
        permission.grantedAt = grantedAt;
        permission.canImpersonate = true;
        permission.isActive = true;
        permission.notifyTenantAdmin = false;
        permission.revokedBy = undefined;
        permission.revokedAt = undefined;
        permission.revocationReason = undefined;
      } else {
        permission = repository.create({
          superAdminId: data.superAdminId,
          superAdminEmail: data.superAdminEmail,
          allowedTenants: [...data.allowedTenants],
          restrictedTenants: data.restrictedTenants ? [...data.restrictedTenants] : undefined,
          defaultPermissions: data.defaultPermissions ? { ...data.defaultPermissions } : undefined,
          canImpersonate: true,
          isActive: true,
          maxSessionDurationMinutes,
          maxConcurrentSessions: Math.min(
            data.maxConcurrentSessions ?? 3,
            IMPERSONATION_MAX_CONCURRENT_SESSIONS,
          ),
          requireReason: data.requireReason ?? true,
          requireTicketReference: data.requireTicketReference ?? false,
          // Notification delivery has no durable authority yet. Persisting true
          // would promise a side effect that the platform cannot prove.
          notifyTenantAdmin: false,
          grantedBy: data.grantedBy,
          grantedAt,
          expiresAt: data.expiresAt,
          notes: data.notes,
        });
      }

      const persisted = await repository.save(permission);
      await this.auditLogService.logRequired(
        {
          action,
          entityType: 'ImpersonationPermission',
          entityId: persisted.id,
          performedBy: data.grantedBy,
          severity: AuditSeverity.CRITICAL,
          details: {
            permissionOwnerId: persisted.superAdminId,
            allowedTenants: persisted.allowedTenants ?? [],
            restrictedTenants: persisted.restrictedTenants ?? [],
            expiresAt: persisted.expiresAt?.toISOString() ?? null,
            maxConcurrentSessions: persisted.maxConcurrentSessions,
            maxSessionDurationMinutes: persisted.maxSessionDurationMinutes,
          },
        },
        manager,
      );
      return persisted;
    });

    this.logger.log(`Granted impersonation permission to: ${data.superAdminId}`);
    return toAdminImpersonationPermissionV1(saved);
  }

  async revokeImpersonationPermission(
    superAdminId: string,
    revokedBy: string,
    reason: string,
  ): Promise<{ terminatedSessionCount: number }> {
    const now = new Date();
    let terminatedSessionCount = 0;

    await this.permissionRepo.manager.transaction(async (manager) => {
      const permissionRepository = manager.withRepository(this.permissionRepo);
      const sessionRepository = manager.withRepository(this.sessionRepo);
      const permission = await permissionRepository.findOne({
        where: { superAdminId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!permission) {
        throw new NotFoundException(`Permission not found for admin: ${superAdminId}`);
      }

      const activeSessions = await sessionRepository
        .createQueryBuilder('session')
        .setLock('pessimistic_write')
        .where('session.superAdminId = :superAdminId', { superAdminId })
        .andWhere('session.status = :status', { status: ImpersonationStatus.ACTIVE })
        .getMany();

      permission.isActive = false;
      permission.canImpersonate = false;
      permission.revokedBy = revokedBy;
      permission.revokedAt = now;
      permission.revocationReason = reason;
      await permissionRepository.save(permission);

      for (const session of activeSessions) {
        session.status = ImpersonationStatus.TERMINATED;
        session.endedAt = now;
        session.endReason = `Permission revoked: ${reason}`;
      }
      if (activeSessions.length > 0) {
        await sessionRepository.save(activeSessions);
      }

      await this.auditLogService.logRequired(
        {
          action: 'IMPERSONATION_PERMISSION_REVOKED',
          entityType: 'ImpersonationPermission',
          entityId: permission.id,
          performedBy: revokedBy,
          severity: AuditSeverity.CRITICAL,
          details: {
            permissionOwnerId: superAdminId,
            reason,
            terminatedSessionCount: activeSessions.length,
          },
        },
        manager,
      );

      for (const session of activeSessions) {
        await this.auditLogService.logRequired(
          {
            action: 'IMPERSONATION_TERMINATED',
            entityType: 'ImpersonationSession',
            entityId: session.id,
            performedBy: revokedBy,
            tenantId: session.targetTenantId,
            severity: AuditSeverity.CRITICAL,
            details: {
              sessionId: session.id,
              sessionOwnerId: superAdminId,
              endReason: session.endReason,
              terminationReason: reason,
              trigger: 'permission_revocation',
            },
          },
          manager,
        );
      }

      terminatedSessionCount = activeSessions.length;
    });

    this.logger.warn(
      `Revoked impersonation permission for ${superAdminId}; terminated ${terminatedSessionCount} active session(s)`,
    );
    return { terminatedSessionCount };
  }

  async getImpersonationPermission(superAdminId: string): Promise<ImpersonationPermission | null> {
    return this.permissionRepo.findOne({
      where: { superAdminId, isActive: true },
    });
  }

  async queryPermissions(params: {
    tenantId?: string;
    isActive?: boolean;
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<IStandardPaginatedResult<AdminImpersonationPermissionV1>> {
    const query = this.permissionRepo.createQueryBuilder('p');

    if (params.tenantId) {
      query.andWhere(':tenantId = ANY(p.allowedTenants)', { tenantId: params.tenantId });
    }
    if (params.isActive !== undefined) {
      query.andWhere('p.isActive = :isActive', { isActive: params.isActive });
    }
    if (params.search?.trim()) {
      query.andWhere('(p.superAdminId::text ILIKE :search OR p.superAdminEmail ILIKE :search)', {
        search: `%${params.search.trim()}%`,
      });
    }

    query.orderBy('p.grantedAt', 'DESC');

    const page = params.page || 1;
    const limit = params.limit || 20;
    query.skip((page - 1) * limit).take(limit);

    const [data, total] = await query.getManyAndCount();
    return createStandardPaginatedResult(
      data.map(toAdminImpersonationPermissionV1),
      total,
      page,
      limit,
    );
  }

  async getImpersonationStats(
    windowDays = 30,
    now = new Date(),
  ): Promise<AdminImpersonationStatsV1<SafeImpersonationSession>> {
    const end = new Date(now);
    const start = new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1_000);
    const [
      activeSessions,
      totalSessions,
      activePermissions,
      actionsRaw,
      topAdminsRaw,
      recentSessions,
    ] = await Promise.all([
      this.sessionRepo.count({ where: { status: ImpersonationStatus.ACTIVE } }),
      this.sessionRepo.count({ where: { createdAt: Between(start, end) } }),
      this.permissionRepo.count({ where: { isActive: true } }),
      this.sessionRepo
        .createQueryBuilder('s')
        .select('COALESCE(SUM(s.actionCount), 0)', 'actionsLogged')
        .where('s.createdAt BETWEEN :start AND :end', { start, end })
        .getRawOne<{ actionsLogged: string }>(),
      this.sessionRepo
        .createQueryBuilder('s')
        .select('s.superAdminId', 'adminId')
        .addSelect('s.superAdminEmail', 'email')
        .addSelect('COUNT(*)', 'sessionCount')
        .where('s.createdAt BETWEEN :start AND :end', { start, end })
        .groupBy('s.superAdminId')
        .addGroupBy('s.superAdminEmail')
        .orderBy('COUNT(*)', 'DESC')
        .limit(5)
        .getRawMany(),
      this.sessionRepo.find({
        where: { createdAt: Between(start, end) },
        order: { createdAt: 'DESC' },
        take: 5,
      }),
    ]);

    return {
      window: {
        days: windowDays,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
      },
      activeSessions,
      totalSessions,
      actionsLogged: Number.parseInt(actionsRaw?.actionsLogged ?? '0', 10),
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

  async getSessionActions(sessionId: string): Promise<readonly AdminImpersonationActionV1[]> {
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId },
      select: ['id', 'actionsPerformed'],
    });
    if (!session) {
      throw new NotFoundException(`Session not found: ${sessionId}`);
    }

    return (session.actionsPerformed ?? []).map((action) => ({
      ...action,
      details: action.details ? { ...action.details } : undefined,
    }));
  }

  async canImpersonate(
    superAdminId: string,
    targetTenantId: string,
  ): Promise<{
    allowed: boolean;
    reason?: string;
    permission?: ImpersonationPermission;
  }> {
    const permission = await this.getImpersonationPermission(superAdminId);
    const scopeDenial = this.getPermissionDenialReason(permission, targetTenantId);
    if (scopeDenial || !permission) {
      return { allowed: false, reason: scopeDenial };
    }

    const activeSessions = await this.sessionRepo.count({
      where: { superAdminId, status: ImpersonationStatus.ACTIVE },
    });
    const concurrencyDenial = this.getPermissionDenialReason(
      permission,
      targetTenantId,
      activeSessions,
    );
    if (concurrencyDenial) {
      return { allowed: false, reason: concurrencyDenial };
    }

    return { allowed: true, permission };
  }

  private getPermissionDenialReason(
    permission: ImpersonationPermission | null,
    targetTenantId: string,
    activeSessionCount?: number,
  ): string | undefined {
    if (!permission) {
      return 'No impersonation permission granted';
    }
    if (!permission.canImpersonate || !permission.isActive) {
      return 'Impersonation permission disabled';
    }
    if (permission.expiresAt && permission.expiresAt < new Date()) {
      return 'Impersonation permission expired';
    }
    if (permission.restrictedTenants?.includes(targetTenantId)) {
      return 'Tenant is restricted for impersonation';
    }
    if (!permission.allowedTenants || permission.allowedTenants.length === 0) {
      return 'No allowed tenants configured - impersonation denied';
    }
    if (!permission.allowedTenants.includes(targetTenantId)) {
      return 'Tenant not in allowed list';
    }
    if (
      activeSessionCount !== undefined &&
      activeSessionCount >= permission.maxConcurrentSessions
    ) {
      return 'Maximum concurrent sessions reached';
    }
    return undefined;
  }

  private restrictRequestedPermissions(
    granted: ImpersonationPermissions | undefined,
    requested: Partial<ImpersonationPermissions> | undefined,
  ): ImpersonationPermissions {
    const maximum: ImpersonationPermissions = granted ?? {
      canViewData: true,
      canModifyData: false,
      canAccessSettings: false,
      canManageUsers: false,
      canViewBilling: false,
      canExportData: false,
    };

    return {
      canViewData: maximum.canViewData && (requested?.canViewData ?? maximum.canViewData),
      canModifyData: maximum.canModifyData && (requested?.canModifyData ?? false),
      canAccessSettings: maximum.canAccessSettings && (requested?.canAccessSettings ?? false),
      canManageUsers: maximum.canManageUsers && (requested?.canManageUsers ?? false),
      canViewBilling: maximum.canViewBilling && (requested?.canViewBilling ?? false),
      canExportData: maximum.canExportData && (requested?.canExportData ?? false),
      restrictedModules:
        maximum.restrictedModules || requested?.restrictedModules
          ? [
              ...new Set([
                ...(maximum.restrictedModules ?? []),
                ...(requested?.restrictedModules ?? []),
              ]),
            ]
          : undefined,
      allowedModules: maximum.allowedModules
        ? maximum.allowedModules.filter(
            (module) => requested?.allowedModules?.includes(module) ?? true,
          )
        : requested?.allowedModules
          ? [...requested.allowedModules]
          : undefined,
    };
  }

  // ============================================================================
  // Session Management
  // ============================================================================

  async startImpersonation(
    request: StartImpersonationRequest,
  ): Promise<StartedImpersonationSession> {
    // SECURITY: Log all impersonation attempts for audit
    this.logger.log(
      `Impersonation attempt: admin=${request.superAdminEmail} (${request.superAdminId}), ` +
        `target=${request.targetTenantId}, ip=${request.ipAddress || 'unknown'}, ` +
        `reason=${request.reason}`,
    );

    // Generate secure tokens
    const rawImpersonationToken = this.generateSecureToken();
    // C-5 fix: store SHA-256 hash of impersonation token, not plaintext
    const impersonationToken = this.hashToken(rawImpersonationToken);
    let durationMinutes = IMPERSONATION_MAX_SESSION_MINUTES;

    // Locking the permission row serializes start with revoke. The session and
    // its mandatory audit fact commit together, so neither a crash nor a
    // concurrent revocation can leave an unaudited/stale-authority session.
    const saved = await this.permissionRepo.manager.transaction(async (manager) => {
      const permissionRepository = manager.withRepository(this.permissionRepo);
      const sessionRepository = manager.withRepository(this.sessionRepo);
      const permission = await permissionRepository.findOne({
        where: { superAdminId: request.superAdminId, isActive: true },
        lock: { mode: 'pessimistic_write' },
      });
      const scopeDenial = this.getPermissionDenialReason(permission, request.targetTenantId);
      if (scopeDenial || !permission) {
        throw new ForbiddenException(scopeDenial);
      }

      const activeSessions = await sessionRepository.count({
        where: {
          superAdminId: request.superAdminId,
          status: ImpersonationStatus.ACTIVE,
        },
      });
      const concurrencyDenial = this.getPermissionDenialReason(
        permission,
        request.targetTenantId,
        activeSessions,
      );
      if (concurrencyDenial) {
        throw new ForbiddenException(concurrencyDenial);
      }

      if (permission.requireReason && !request.reason) {
        throw new BadRequestException('Reason is required for impersonation');
      }
      if (permission.requireTicketReference && !request.ticketReference) {
        throw new BadRequestException('Ticket reference is required for impersonation');
      }

      durationMinutes = Math.min(
        request.durationMinutes || IMPERSONATION_MAX_SESSION_MINUTES,
        permission.maxSessionDurationMinutes,
        IMPERSONATION_MAX_SESSION_MINUTES,
      );
      const expiresAt = new Date(Date.now() + durationMinutes * 60000);
      const permissions = this.restrictRequestedPermissions(
        permission.defaultPermissions,
        request.permissions,
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
        expiresAt,
        actionsPerformed: [],
        accessedResources: [],
        actionCount: 0,
      });
      const persisted = await sessionRepository.save(session);

      await this.auditLogService.logRequired(
        {
          action: 'IMPERSONATION_STARTED',
          entityType: 'ImpersonationSession',
          entityId: persisted.id,
          performedBy: request.superAdminId,
          tenantId: request.targetTenantId,
          ipAddress: request.ipAddress,
          details: {
            sessionId: persisted.id,
            targetTenantId: request.targetTenantId,
            targetUserId: request.targetUserId,
            reason: request.reason,
            reasonDetails: request.reasonDetails,
            ticketReference: request.ticketReference,
            durationMinutes,
          },
        },
        manager,
      );

      return persisted;
    });

    this.logger.log(
      `Started impersonation: ${request.superAdminEmail} -> ${request.targetTenantName || request.targetTenantId}`,
    );

    // C-5 fix: Return raw token to caller (only time it's available in plaintext).
    // DB-ADMIN-HIGH-002: the explicit projection never exposes persistence-only
    // columns and re-attaches only the one credential the initiator needs.
    return { ...toSafeImpersonationSession(saved), impersonationToken: rawImpersonationToken };
  }

  async endImpersonation(
    sessionId: string,
    endReason?: string,
    endedBy?: string,
  ): Promise<SafeImpersonationSession> {
    const saved = await this.sessionRepo.manager.transaction(async (manager) => {
      const repository = manager.withRepository(this.sessionRepo);
      const session = await repository.findOne({
        where: { id: sessionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!session) {
        throw new NotFoundException(`Session not found: ${sessionId}`);
      }
      if (session.status !== ImpersonationStatus.ACTIVE) {
        throw new BadRequestException(`Session is not active: ${session.status}`);
      }
      if (endedBy && session.superAdminId !== endedBy) {
        throw new ForbiddenException('Bu oturumu sonlandırma yetkiniz yok');
      }

      session.status = ImpersonationStatus.ENDED;
      session.endedAt = new Date();
      session.endReason = endReason || (endedBy ? 'Ended by user' : 'Manual termination');
      const persisted = await repository.save(session);

      await this.auditLogService.logRequired(
        {
          action: 'IMPERSONATION_ENDED',
          entityType: 'ImpersonationSession',
          entityId: persisted.id,
          performedBy: endedBy || session.superAdminId,
          tenantId: session.targetTenantId,
          details: {
            sessionId: persisted.id,
            endReason: persisted.endReason,
            durationActualMinutes:
              persisted.endedAt && session.createdAt
                ? Math.round((persisted.endedAt.getTime() - session.createdAt.getTime()) / 60000)
                : null,
          },
        },
        manager,
      );
      return persisted;
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
    const saved = await this.sessionRepo.manager.transaction(async (manager) => {
      const repository = manager.withRepository(this.sessionRepo);
      const session = await repository.findOne({
        where: { id: sessionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!session) {
        throw new NotFoundException(`Session not found: ${sessionId}`);
      }
      if (session.status !== ImpersonationStatus.ACTIVE) {
        throw new BadRequestException(`Session is not active: ${session.status}`);
      }

      session.status = ImpersonationStatus.TERMINATED;
      session.endedAt = new Date();
      session.endReason = `Terminated by ${terminatedBy}: ${reason}`;
      const persisted = await repository.save(session);

      await this.auditLogService.logRequired(
        {
          action: 'IMPERSONATION_TERMINATED',
          entityType: 'ImpersonationSession',
          entityId: persisted.id,
          performedBy: terminatedBy,
          tenantId: session.targetTenantId,
          severity: AuditSeverity.CRITICAL,
          details: {
            sessionId: persisted.id,
            sessionOwnerId: session.superAdminId,
            endReason: persisted.endReason,
            terminationReason: reason,
          },
        },
        manager,
      );
      return persisted;
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
    const sessionIdentity = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!sessionIdentity) {
      throw new NotFoundException(`Session not found: ${sessionId}`);
    }
    const saved = await this.permissionRepo.manager.transaction(async (manager) => {
      const permissionRepository = manager.withRepository(this.permissionRepo);
      const sessionRepository = manager.withRepository(this.sessionRepo);
      const permission = await permissionRepository.findOne({
        where: { superAdminId: sessionIdentity.superAdminId, isActive: true },
        lock: { mode: 'pessimistic_write' },
      });
      const denialReason = this.getPermissionDenialReason(
        permission,
        sessionIdentity.targetTenantId,
      );
      if (denialReason || !permission) {
        throw new ForbiddenException(denialReason);
      }

      const session = await sessionRepository.findOne({
        where: { id: sessionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!session) {
        throw new NotFoundException(`Session not found: ${sessionId}`);
      }
      if (session.status !== ImpersonationStatus.ACTIVE || session.expiresAt <= new Date()) {
        throw new BadRequestException('Session is not active');
      }
      if (session.superAdminId !== extendedBy) {
        throw new ForbiddenException('Bu oturumu uzatma yetkiniz yok');
      }

      const maxDurationMinutes = Math.min(
        permission.maxSessionDurationMinutes,
        IMPERSONATION_MAX_SESSION_MINUTES,
      );
      const newExpiresAt = session.expiresAt.getTime() + additionalMinutes * 60000;
      const totalDurationMinutes = (newExpiresAt - session.createdAt.getTime()) / 60000;
      if (totalDurationMinutes > maxDurationMinutes) {
        throw new BadRequestException(
          `Toplam oturum suresi maksimum ${maxDurationMinutes} dakikayi asamaz`,
        );
      }

      session.expiresAt = new Date(newExpiresAt);
      session.actionsPerformed = [
        ...(session.actionsPerformed ?? []),
        {
          action: 'session_extended',
          resource: 'impersonation_session',
          resourceId: sessionId,
          timestamp: new Date().toISOString(),
          details: {
            additionalMinutes,
            newExpiresAt: session.expiresAt.toISOString(),
            extendedBy,
          },
        },
      ].slice(-1000);
      session.actionCount = (session.actionCount || 0) + 1;
      const persisted = await sessionRepository.save(session);

      await this.auditLogService.logRequired(
        {
          action: 'IMPERSONATION_EXTENDED',
          entityType: 'ImpersonationSession',
          entityId: persisted.id,
          performedBy: extendedBy,
          tenantId: session.targetTenantId,
          details: {
            sessionId: persisted.id,
            additionalMinutes,
            newExpiresAt: persisted.expiresAt.toISOString(),
            sessionOwnerId: session.superAdminId,
          },
        },
        manager,
      );
      return persisted;
    });

    this.logger.log(`Extended impersonation session ${sessionId} by ${additionalMinutes} minutes`);

    // DB-ADMIN-HIGH-002: never echo the stored token columns on the extend response.
    return toSafeImpersonationSession(saved);
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
    return this.sessionRepo.findOne({
      where: {
        id: sessionId,
        status: ImpersonationStatus.ACTIVE,
        expiresAt: MoreThan(new Date()),
      },
    });
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
    performedBy?: string,
  ): Promise<void> {
    if (!performedBy) {
      throw new ForbiddenException('Authenticated operator identity is required');
    }
    await this.sessionRepo.manager.transaction(async (manager) => {
      const repository = manager.withRepository(this.sessionRepo);
      const session = await repository.findOne({
        where: { id: sessionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!session) {
        throw new NotFoundException(`Session not found: ${sessionId}`);
      }
      if (session.status !== ImpersonationStatus.ACTIVE || session.expiresAt <= new Date()) {
        throw new BadRequestException('Session is not active');
      }
      if (session.superAdminId !== performedBy) {
        throw new ForbiddenException('Cannot append actions to another operator session');
      }

      const actionEntry: ImpersonationAction = {
        action,
        resource,
        resourceId,
        timestamp: new Date().toISOString(),
        details,
      };
      session.actionsPerformed = [...(session.actionsPerformed ?? []), actionEntry].slice(-1000);
      session.actionCount = (session.actionCount || 0) + 1;
      await repository.save(session);
      await this.auditLogService.logRequired(
        {
          action: 'IMPERSONATION_ACTION_LOGGED',
          entityType: 'ImpersonationSession',
          entityId: session.id,
          performedBy,
          tenantId: session.targetTenantId,
          details: {
            action,
            resource,
            resourceId: resourceId ?? null,
            sessionOwnerId: session.superAdminId,
          },
        },
        manager,
      );
    });
  }

  async logResourceAccess(
    sessionId: string,
    resourceType: string,
    resourceId: string,
    action: string,
    performedBy?: string,
  ): Promise<void> {
    if (!performedBy) {
      throw new ForbiddenException('Authenticated operator identity is required');
    }
    await this.sessionRepo.manager.transaction(async (manager) => {
      const repository = manager.withRepository(this.sessionRepo);
      const session = await repository.findOne({
        where: { id: sessionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!session) {
        throw new NotFoundException(`Session not found: ${sessionId}`);
      }
      if (session.status !== ImpersonationStatus.ACTIVE || session.expiresAt <= new Date()) {
        throw new BadRequestException('Session is not active');
      }
      if (session.superAdminId !== performedBy) {
        throw new ForbiddenException('Cannot append resource access to another operator session');
      }

      session.accessedResources = [
        ...(session.accessedResources ?? []),
        {
          type: resourceType,
          id: resourceId,
          action,
          timestamp: new Date().toISOString(),
        },
      ].slice(-500);
      await repository.save(session);
      await this.auditLogService.logRequired(
        {
          action: 'IMPERSONATION_RESOURCE_ACCESSED',
          entityType: 'ImpersonationSession',
          entityId: session.id,
          performedBy,
          tenantId: session.targetTenantId,
          details: {
            action,
            resourceId,
            resourceType,
            sessionOwnerId: session.superAdminId,
          },
        },
        manager,
      );
    });
  }

  // ============================================================================
  // Query & Reports
  // ============================================================================

  async querySessions(params: {
    superAdminId?: string;
    targetTenantId?: string;
    status?: ImpersonationStatus;
    reason?: ImpersonationReason;
    scope?: AdminImpersonationSessionScopeV1;
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
    if (
      params.status &&
      ((params.scope === 'active' && params.status !== ImpersonationStatus.ACTIVE) ||
        (params.scope === 'history' && params.status === ImpersonationStatus.ACTIVE))
    ) {
      throw new BadRequestException('Session status conflicts with the requested lifecycle scope');
    }
    if (params.status) {
      query.andWhere('s.status = :status', { status: params.status });
    } else if (params.scope === 'active') {
      query.andWhere('s.status = :status', { status: ImpersonationStatus.ACTIVE });
    } else if (params.scope === 'history') {
      query.andWhere('s.status IN (:...historyStatuses)', {
        historyStatuses: [
          ImpersonationStatus.ENDED,
          ImpersonationStatus.EXPIRED,
          ImpersonationStatus.TERMINATED,
        ],
      });
    }
    if (params.reason) {
      query.andWhere('s.reason = :reason', { reason: params.reason });
    }
    if (params.startDate) {
      query.andWhere('s.createdAt >= :startDate', { startDate: params.startDate });
    }
    if (params.endDate) {
      query.andWhere('s.createdAt <= :endDate', { endDate: params.endDate });
    }
    if (params.search?.trim()) {
      query.andWhere(
        `(
          s.superAdminId::text ILIKE :search OR
          s.superAdminEmail ILIKE :search OR
          s.targetTenantId::text ILIKE :search OR
          s.targetTenantName ILIKE :search OR
          s.targetUserEmail ILIKE :search
        )`,
        { search: `%${params.search.trim()}%` },
      );
    }

    query.orderBy('s.createdAt', 'DESC');

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
    const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate || new Date();

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
        where: { status: ImpersonationStatus.ACTIVE },
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
    await this.sessionRepo.manager.transaction(async (manager) => {
      const repository = manager.withRepository(this.sessionRepo);
      const persisted = await repository.findOne({
        where: { id: session.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !persisted ||
        persisted.status !== ImpersonationStatus.ACTIVE ||
        persisted.expiresAt >= new Date()
      ) {
        return;
      }

      persisted.status = ImpersonationStatus.EXPIRED;
      persisted.endedAt = new Date();
      persisted.endReason = 'Session expired';
      const expired = await repository.save(persisted);

      await this.auditLogService.logRequired(
        {
          action: 'IMPERSONATION_EXPIRED',
          entityType: 'ImpersonationSession',
          entityId: expired.id,
          performedBy: 'system:cron',
          tenantId: expired.targetTenantId,
          details: {
            sessionId: expired.id,
            sessionOwnerId: expired.superAdminId,
            durationActualMinutes:
              expired.endedAt && expired.createdAt
                ? Math.round((expired.endedAt.getTime() - expired.createdAt.getTime()) / 60000)
                : null,
          },
        },
        manager,
      );
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

  // ============================================================================
  // Active Sessions Info
  // ============================================================================

  async getActiveSessions(): Promise<SafeImpersonationSession[]> {
    const active = await this.sessionRepo.find({
      where: {
        status: ImpersonationStatus.ACTIVE,
        expiresAt: MoreThan(new Date()),
      },
      order: { createdAt: 'DESC' },
    });
    return active.map(toSafeImpersonationSession);
  }

  async getActiveSessionCount(): Promise<number> {
    return this.sessionRepo.count({
      where: {
        status: ImpersonationStatus.ACTIVE,
        expiresAt: MoreThan(new Date()),
      },
    });
  }
}
