import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';

import {
  DebugSession,
  DebugSessionType,
  QueryLogType,
} from '../entities/debug-session.entity';

/**
 * Debug Session Service
 * Handles debug session lifecycle management
 * SRP: Only responsible for session CRUD operations
 */
@Injectable()
export class DebugSessionService {
  private readonly logger = new Logger(DebugSessionService.name);

  constructor(
    @InjectRepository(DebugSession)
    private readonly debugSessionRepo: Repository<DebugSession>,
  ) {}

  /**
   * Start a new debug session
   */
  async startDebugSession(data: {
    adminId: string;
    tenantId: string;
    sessionType: DebugSessionType;
    configuration?: Record<string, unknown>;
    filters?: {
      startTime?: Date;
      endTime?: Date;
      queryTypes?: QueryLogType[];
      apiEndpoints?: string[];
      cacheKeys?: string[];
      minDuration?: number;
      includeErrors?: boolean;
      userId?: string;
    };
    maxResults?: number;
    durationMinutes?: number;
  }): Promise<DebugSession> {
    const expiresAt = new Date(Date.now() + (data.durationMinutes || 30) * 60000);

    const session = this.debugSessionRepo.create({
      adminId: data.adminId,
      tenantId: data.tenantId,
      sessionType: data.sessionType,
      isActive: true,
      configuration: data.configuration,
      filters: data.filters,
      maxResults: data.maxResults || 1000,
      expiresAt,
    });

    const saved = await this.debugSessionRepo.save(session);
    this.logger.log(`Started debug session: ${saved.sessionType} for tenant ${data.tenantId}`);
    return saved;
  }

  /**
   * End a debug session
   */
  async endDebugSession(sessionId: string): Promise<DebugSession> {
    const session = await this.debugSessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException(`Debug session not found: ${sessionId}`);
    }

    session.isActive = false;
    return this.debugSessionRepo.save(session);
  }

  /**
   * Get a debug session by ID
   */
  async getDebugSession(sessionId: string): Promise<DebugSession> {
    const session = await this.debugSessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException(`Debug session not found: ${sessionId}`);
    }
    return session;
  }

  /**
   * Get active sessions for a tenant
   */
  async getActiveSessionsForTenant(tenantId: string): Promise<DebugSession[]> {
    return this.debugSessionRepo.find({
      where: { tenantId, isActive: true },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get active sessions by type for a tenant
   */
  async getActiveSessionsByType(tenantId: string, sessionType: DebugSessionType): Promise<DebugSession[]> {
    return this.debugSessionRepo.find({
      where: { tenantId, sessionType, isActive: true },
    });
  }

  /**
   * Query debug sessions with filters
   */
  async querySessions(params: {
    tenantId?: string;
    sessionType?: DebugSessionType;
    isActive?: boolean;
    page?: number;
    limit?: number;
  }): Promise<{ data: DebugSession[]; total: number; page: number; limit: number }> {
    const page = params.page || 1;
    const limit = params.limit || 20;
    const skip = (page - 1) * limit;

    const query = this.debugSessionRepo.createQueryBuilder('s');

    if (params.tenantId) {
      query.andWhere('s.tenantId = :tenantId', { tenantId: params.tenantId });
    }
    if (params.sessionType) {
      query.andWhere('s.sessionType = :sessionType', { sessionType: params.sessionType });
    }
    if (params.isActive !== undefined) {
      query.andWhere('s.isActive = :isActive', { isActive: params.isActive });
    }

    query.orderBy('s.createdAt', 'DESC');
    query.skip(skip).take(limit);

    const [data, total] = await query.getManyAndCount();

    return { data, total, page, limit };
  }

  /**
   * Get all active sessions (for dashboard)
   */
  async getAllActiveSessions(limit: number = 10): Promise<DebugSession[]> {
    return this.debugSessionRepo.find({
      where: { isActive: true },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * Expire debug sessions that have passed their expiration time
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async expireDebugSessions(): Promise<void> {
    const expired = await this.debugSessionRepo.find({
      where: {
        isActive: true,
        expiresAt: LessThan(new Date()),
      },
    });

    for (const session of expired) {
      session.isActive = false;
      await this.debugSessionRepo.save(session);
    }

    if (expired.length > 0) {
      this.logger.debug(`Expired ${expired.length} debug sessions`);
    }
  }

  /**
   * Cleanup old inactive sessions
   */
  async cleanupOldSessions(daysOld: number = 7): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);

    const result = await this.debugSessionRepo.delete({
      isActive: false,
      createdAt: LessThan(cutoff),
    });

    return result.affected || 0;
  }
}
