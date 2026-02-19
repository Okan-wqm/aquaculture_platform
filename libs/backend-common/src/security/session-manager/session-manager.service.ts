import { Injectable, Logger, OnModuleDestroy, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import Redis from 'ioredis';

import {
  ISessionManager,
  SessionMetadata,
  SessionInfo,
} from '../interfaces';

/**
 * Session data stored in backend
 */
interface StoredSession {
  sessionId: string;
  userId: string;
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
  metadata: SessionMetadata;
  isActive: boolean;
}

/**
 * Session Manager Service
 *
 * Provides concurrent session management:
 * - Track active sessions per user
 * - Enforce maximum session limits
 * - Session revocation (single or all)
 * - Activity tracking
 *
 * SOLID Principles:
 * - Single Responsibility: Only manages sessions
 * - Interface Segregation: Implements ISessionManager
 * - Dependency Inversion: Depends on abstraction
 */
@Injectable()
export class SessionManagerService implements ISessionManager, OnModuleDestroy {
  private readonly logger = new Logger(SessionManagerService.name);

  // In-memory storage for single-instance deployments
  private readonly sessions = new Map<string, StoredSession>();
  private readonly userSessions = new Map<string, Set<string>>();

  // Configuration
  private readonly maxSessionsPerUser: number;
  private readonly sessionTtlMs: number;
  private readonly useRedis: boolean;
  private readonly keyPrefix = 'session:';
  private readonly cleanupInterval: NodeJS.Timeout;

  constructor(
    private readonly configService: ConfigService,
    @Optional() @Inject('REDIS_CLIENT') private readonly redis?: Redis,
  ) {
    this.maxSessionsPerUser = this.configService.get<number>('MAX_SESSIONS_PER_USER', 5);
    this.sessionTtlMs = this.configService.get<number>('SESSION_TTL_MS', 24 * 60 * 60 * 1000); // 24 hours
    this.useRedis = this.configService.get<boolean>('SESSION_USE_REDIS', false) && !!redis;

    // Cleanup every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanupExpiredSessions(), 300000);

    const nodeEnv = this.configService.get<string>('NODE_ENV', 'development');
    if (!this.useRedis && nodeEnv === 'production') {
      this.logger.error(
        'SessionManagerService is using in-memory storage in production. ' +
        'Session limits and revocation will NOT work across multiple instances. ' +
        'Set SESSION_USE_REDIS=true and provide a Redis connection.',
      );
      throw new Error(
        'SessionManagerService requires Redis in production. ' +
        'Set SESSION_USE_REDIS=true and provide a Redis connection.',
      );
    }

    if (!this.useRedis) {
      this.logger.warn(
        'SessionManagerService is using in-memory storage. ' +
        'This is only suitable for single-instance development/test environments.',
      );
    }

    this.logger.log(
      `Session manager initialized (max sessions: ${this.maxSessionsPerUser}, ` +
      `TTL: ${this.sessionTtlMs / 1000 / 60} minutes, ` +
      `storage: ${this.useRedis ? 'Redis' : 'in-memory'})`,
    );
  }

  onModuleDestroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.sessions.clear();
    this.userSessions.clear();
  }

  /**
   * Create a new session
   */
  async createSession(userId: string, metadata: SessionMetadata): Promise<string> {
    const sessionId = this.generateSessionId();
    const now = Date.now();

    const session: StoredSession = {
      sessionId,
      userId,
      createdAt: now,
      lastActivityAt: now,
      expiresAt: now + this.sessionTtlMs,
      metadata,
      isActive: true,
    };

    // Enforce session limit before creating new session
    await this.enforceSessionLimit(userId, this.maxSessionsPerUser - 1);

    if (this.useRedis && this.redis) {
      const sessionKey = `${this.keyPrefix}${sessionId}`;
      const userKey = `${this.keyPrefix}user:${userId}`;

      await this.redis.setex(
        sessionKey,
        Math.ceil(this.sessionTtlMs / 1000),
        JSON.stringify(session),
      );

      // Add to user's session set
      await this.redis.sadd(userKey, sessionId);
      await this.redis.expire(userKey, Math.ceil(this.sessionTtlMs / 1000));
    } else {
      this.sessions.set(sessionId, session);

      // Track user sessions
      if (!this.userSessions.has(userId)) {
        this.userSessions.set(userId, new Set());
      }
      this.userSessions.get(userId)!.add(sessionId);
    }

    this.logger.debug(`Session created for user ${userId}: ${sessionId.substring(0, 8)}...`);
    return sessionId;
  }

  /**
   * Validate session is active
   */
  async validateSession(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);

    if (!session) return false;
    if (!session.isActive) return false;
    if (Date.now() > session.expiresAt) {
      await this.revokeSession(sessionId, 'expired');
      return false;
    }

    // Update last activity
    await this.updateLastActivity(sessionId);

    return true;
  }

  /**
   * Get all active sessions for user
   */
  async getUserSessions(userId: string): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = [];

    if (this.useRedis && this.redis) {
      const userKey = `${this.keyPrefix}user:${userId}`;
      const sessionIds = await this.redis.smembers(userKey);

      for (const sessionId of sessionIds) {
        const session = await this.getSession(sessionId);
        if (session && session.isActive) {
          sessions.push(this.toSessionInfo(session));
        }
      }
    } else {
      const userSessionIds = this.userSessions.get(userId) || new Set();

      for (const sessionId of userSessionIds) {
        const session = this.sessions.get(sessionId);
        if (session && session.isActive) {
          sessions.push(this.toSessionInfo(session));
        }
      }
    }

    // Sort by last activity (most recent first)
    return sessions.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
  }

  /**
   * Revoke a specific session
   */
  async revokeSession(sessionId: string, reason?: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) return;

    if (this.useRedis && this.redis) {
      const sessionKey = `${this.keyPrefix}${sessionId}`;
      const userKey = `${this.keyPrefix}user:${session.userId}`;

      await this.redis.del(sessionKey);
      await this.redis.srem(userKey, sessionId);
    } else {
      this.sessions.delete(sessionId);
      this.userSessions.get(session.userId)?.delete(sessionId);
    }

    this.logger.debug(
      `Session revoked: ${sessionId.substring(0, 8)}... (reason: ${reason || 'none'})`,
    );
  }

  /**
   * Revoke all sessions for user
   */
  async revokeAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
    const sessions = await this.getUserSessions(userId);
    let revokedCount = 0;

    for (const session of sessions) {
      if (session.sessionId !== exceptSessionId) {
        await this.revokeSession(session.sessionId, 'revoke_all');
        revokedCount++;
      }
    }

    this.logger.log(`Revoked ${revokedCount} sessions for user ${userId}`);
    return revokedCount;
  }

  /**
   * Enforce concurrent session limit
   * Revokes oldest sessions if limit exceeded
   */
  async enforceSessionLimit(userId: string, maxSessions: number): Promise<string[]> {
    const sessions = await this.getUserSessions(userId);
    const revokedIds: string[] = [];

    if (sessions.length <= maxSessions) {
      return revokedIds;
    }

    // Sort by last activity (oldest first)
    const sortedSessions = sessions.sort(
      (a, b) => a.lastActivityAt.getTime() - b.lastActivityAt.getTime(),
    );

    // Revoke oldest sessions
    const sessionsToRevoke = sortedSessions.slice(0, sessions.length - maxSessions);

    for (const session of sessionsToRevoke) {
      await this.revokeSession(session.sessionId, 'session_limit_exceeded');
      revokedIds.push(session.sessionId);
    }

    if (revokedIds.length > 0) {
      this.logger.log(
        `Revoked ${revokedIds.length} sessions for user ${userId} due to session limit`,
      );
    }

    return revokedIds;
  }

  /**
   * Get active session count for user
   */
  async getSessionCount(userId: string): Promise<number> {
    const sessions = await this.getUserSessions(userId);
    return sessions.filter(s => s.isActive).length;
  }

  /**
   * Update session configuration at runtime
   */
  setMaxSessionsPerUser(limit: number): void {
    (this as unknown as { maxSessionsPerUser: number }).maxSessionsPerUser = limit;
    this.logger.log(`Max sessions per user updated to: ${limit}`);
  }

  /**
   * Get session details
   */
  private async getSession(sessionId: string): Promise<StoredSession | null> {
    if (this.useRedis && this.redis) {
      const sessionKey = `${this.keyPrefix}${sessionId}`;
      const data = await this.redis.get(sessionKey);
      if (!data) return null;

      try {
        return JSON.parse(data) as StoredSession;
      } catch {
        return null;
      }
    }

    return this.sessions.get(sessionId) || null;
  }

  /**
   * Update last activity timestamp
   */
  private async updateLastActivity(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) return;

    session.lastActivityAt = Date.now();

    if (this.useRedis && this.redis) {
      const sessionKey = `${this.keyPrefix}${sessionId}`;
      const ttl = await this.redis.ttl(sessionKey);
      if (ttl > 0) {
        await this.redis.setex(sessionKey, ttl, JSON.stringify(session));
      }
    }
    // In-memory is updated in place
  }

  /**
   * Generate secure session ID
   */
  private generateSessionId(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Convert stored session to SessionInfo
   */
  private toSessionInfo(session: StoredSession): SessionInfo {
    return {
      sessionId: session.sessionId,
      userId: session.userId,
      createdAt: new Date(session.createdAt),
      lastActivityAt: new Date(session.lastActivityAt),
      expiresAt: new Date(session.expiresAt),
      metadata: session.metadata,
      isActive: session.isActive,
    };
  }

  /**
   * Cleanup expired sessions
   */
  private async cleanupExpiredSessions(): Promise<void> {
    if (this.useRedis) {
      // Redis handles TTL automatically
      return;
    }

    const now = Date.now();
    let cleaned = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      if (now > session.expiresAt || !session.isActive) {
        this.sessions.delete(sessionId);
        this.userSessions.get(session.userId)?.delete(sessionId);
        cleaned++;
      }
    }

    // Clean up empty user session sets
    for (const [userId, sessions] of this.userSessions.entries()) {
      if (sessions.size === 0) {
        this.userSessions.delete(userId);
      }
    }

    if (cleaned > 0) {
      this.logger.debug(`Cleaned up ${cleaned} expired sessions`);
    }
  }
}
