import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, In } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as crypto from 'crypto';

import {
  ImpersonationSession,
  ImpersonationPermission,
  ImpersonationStatus,
  ImpersonationReason,
  ImpersonationPermissions,
  ImpersonationAction,
} from '../entities/impersonation-session.entity';

// ============================================================================
// Interfaces
// ============================================================================

export interface StartImpersonationRequest {
  superAdminId: string;
  superAdminEmail: string;
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
  recentSessions: ImpersonationSession[];
}

// ============================================================================
// Impersonation Service
// ============================================================================

@Injectable()
export class ImpersonationService {
  private readonly logger = new Logger(ImpersonationService.name);
  private activeSessions: Map<string, ImpersonationSession> = new Map();
  private readonly TOKEN_EXPIRY_BUFFER_MS = 60000; // 1 minute

  constructor(
    @InjectRepository(ImpersonationSession)
    private readonly sessionRepo: Repository<ImpersonationSession>,
    @InjectRepository(ImpersonationPermission)
    private readonly permissionRepo: Repository<ImpersonationPermission>,
  ) {
    this.loadActiveSessions();
  }

  private async loadActiveSessions(): Promise<void> {
    const active = await this.sessionRepo.find({
      where: { status: ImpersonationStatus.ACTIVE },
    });
    for (const session of active) {
      this.activeSessions.set(session.id, session);
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
    } else {
      permission = this.permissionRepo.create({
        ...data,
        canImpersonate: true,
        isActive: true,
        maxSessionDurationMinutes: data.maxSessionDurationMinutes || 60,
        maxConcurrentSessions: data.maxConcurrentSessions || 3,
        requireReason: data.requireReason ?? true,
        requireTicketReference: data.requireTicketReference ?? false,
        notifyTenantAdmin: data.notifyTenantAdmin ?? true,
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
  }): Promise<{ data: ImpersonationPermission[]; total: number; page: number; limit: number }> {
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
    return { data, total, page, limit };
  }

  async getImpersonationStats(): Promise<{
    activeSessions: number;
    totalSessions: number;
    activePermissions: number;
    topAdmins: Array<{ adminId: string; email: string; sessionCount: number }>;
    recentSessions: ImpersonationSession[];
  }> {
    const [activeSessions, totalSessions, activePermissions, topAdminsRaw, recentSessions] =
      await Promise.all([
        this.sessionRepo.count({ where: { status: ImpersonationStatus.ACTIVE } }),
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
      recentSessions,
    };
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

  async startImpersonation(request: StartImpersonationRequest): Promise<ImpersonationSession> {
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

    // Calculate expiration
    const durationMinutes = Math.min(
      request.durationMinutes || 60,
      permission?.maxSessionDurationMinutes || 60,
    );
    const expiresAt = new Date(Date.now() + durationMinutes * 60000);

    // Generate secure tokens
    const originalSessionToken = this.generateSecureToken();
    const impersonationToken = this.generateSecureToken();

    // Merge permissions
    const defaultPerms: ImpersonationPermissions = {
      canViewData: true,
      canModifyData: false,
      canAccessSettings: false,
      canManageUsers: false,
      canViewBilling: false,
      canExportData: false,
    };

    const permissions: ImpersonationPermissions = {
      ...defaultPerms,
      ...permission?.defaultPermissions,
      ...request.permissions,
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
    this.activeSessions.set(saved.id, saved);

    // Notify tenant admin if configured
    if (permission?.notifyTenantAdmin) {
      await this.notifyTenantAdmin(saved);
    }

    this.logger.log(
      `Started impersonation: ${request.superAdminEmail} -> ${request.targetTenantName || request.targetTenantId}`,
    );

    return saved;
  }

  async endImpersonation(
    sessionId: string,
    endReason?: string,
    endedBy?: string,
  ): Promise<ImpersonationSession> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException(`Session not found: ${sessionId}`);
    }

    if (session.status !== ImpersonationStatus.ACTIVE) {
      throw new BadRequestException(`Session is not active: ${session.status}`);
    }

    session.status = ImpersonationStatus.ENDED;
    session.endedAt = new Date();
    session.endReason = endReason || (endedBy ? 'Ended by user' : 'Manual termination');

    const saved = await this.sessionRepo.save(session);
    this.activeSessions.delete(sessionId);

    this.logger.log(`Ended impersonation session: ${sessionId}`);

    return saved;
  }

  async terminateSession(
    sessionId: string,
    terminatedBy: string,
    reason: string,
  ): Promise<ImpersonationSession> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException(`Session not found: ${sessionId}`);
    }

    session.status = ImpersonationStatus.TERMINATED;
    session.endedAt = new Date();
    session.endReason = `Terminated by ${terminatedBy}: ${reason}`;

    const saved = await this.sessionRepo.save(session);
    this.activeSessions.delete(sessionId);

    this.logger.warn(`Terminated impersonation session: ${sessionId} - ${reason}`);

    return saved;
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

  async validateSession(token: string): Promise<ImpersonationContext | null> {
    // Find session by token
    const session = await this.sessionRepo.findOne({
      where: { impersonationToken: token, status: ImpersonationStatus.ACTIVE },
    });

    if (!session) {
      return null;
    }

    // Check expiration
    if (session.expiresAt < new Date()) {
      await this.expireSession(session);
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
    return this.activeSessions.get(sessionId) || null;
  }

  async getSessionByToken(token: string): Promise<ImpersonationSession | null> {
    return this.sessionRepo.findOne({
      where: { impersonationToken: token },
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
      timestamp: new Date(),
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
    this.activeSessions.set(sessionId, session);
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
      timestamp: new Date(),
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
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
  }): Promise<{ items: ImpersonationSession[]; total: number }> {
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
    return { items, total };
  }

  async getSession(id: string): Promise<ImpersonationSession> {
    const session = await this.sessionRepo.findOne({ where: { id } });
    if (!session) {
      throw new NotFoundException(`Session not found: ${id}`);
    }
    return session;
  }

  async getAuditSummary(
    startDate?: Date,
    endDate?: Date,
  ): Promise<ImpersonationAuditSummary> {
    const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate || new Date();

    const [totalSessions, activeSessions, sessionsByReasonRaw, topImpersonatorsRaw, topTenantsRaw, recentSessions] =
      await Promise.all([
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
      recentSessions,
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
    this.activeSessions.delete(session.id);
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private generateSecureToken(): string {
    return crypto.randomBytes(32).toString('hex');
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

  getActiveSessions(): ImpersonationSession[] {
    return Array.from(this.activeSessions.values());
  }

  getActiveSessionCount(): number {
    return this.activeSessions.size;
  }
}
