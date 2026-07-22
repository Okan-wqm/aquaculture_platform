import { Role } from '@aquaculture/backend-common/decorators';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  AUTH_ADMIN_COMMAND_SUBJECTS,
  type AdminCreateUserCommand,
  type AdminCreateUserResult,
  type AdminDeactivateUserCommand,
  type AdminDeactivateUserResult,
  type AdminForceLogoutUserCommand,
  type AdminForceLogoutUserResult,
  type AdminResetUserPasswordCommand,
  type AdminResetUserPasswordResult,
  type AdminUpdateUserCommand,
  type AdminUpdateUserResult,
} from '@platform/event-contracts';
import { catchError, firstValueFrom, throwError, timeout } from 'rxjs';
import { DataSource } from 'typeorm';

import { createStandardPaginatedResult } from '@aquaculture/backend-common/pagination';

import { UserActivity } from './dto/user-activity.dto';

/**
 * Default NATS request timeout when AUTH_NATS_TIMEOUT_MS is not configured.
 * 15 s matches the messaging-admin NATS client and leaves headroom for
 * bcrypt cost rounds 12+ on the auth-service worker.
 */
const DEFAULT_AUTH_NATS_TIMEOUT_MS = 15_000;

export interface UserFilter {
  tenantId?: string;
  role?: Role;
  status?: 'active' | 'inactive' | 'all';
  search?: string;
}

export interface UserDto {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  tenantId: string | null;
  tenantName: string | null;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaginatedUsers {
  items: UserDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface UserStats {
  totalUsers: number;
  activeUsers: number;
  inactiveUsers: number;
  usersByRole: { role: string; count: number }[];
  usersByTenant: { tenantId: string; tenantName: string; count: number }[];
  newUsersLast30Days: number;
  loginsLast24Hours: number;
}

export interface UserSession {
  id: string;
  token: string;
  ipAddress: string;
  userAgent: string;
  createdAt: Date;
  expiresAt: Date;
  isActive: boolean;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  private readonly authNatsTimeoutMs: number;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject('AUTH_NATS_CLIENT')
    private readonly authNatsClient: ClientProxy,
  ) {
    const configured = parseInt(process.env['AUTH_NATS_TIMEOUT_MS'] ?? '', 10);
    this.authNatsTimeoutMs = Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_AUTH_NATS_TIMEOUT_MS;
  }

  /**
   * List all users with filtering and pagination
   */
  async listUsers(
    filter: UserFilter,
    page = 1,
    limit = 20,
    sortBy = 'createdAt',
    sortOrder: 'ASC' | 'DESC' = 'DESC',
  ): Promise<PaginatedUsers> {
    const offset = (page - 1) * limit;

    const whereConditions: string[] = [];
    const params: (string | boolean)[] = [];
    let paramIndex = 1;

    if (filter.tenantId) {
      whereConditions.push(`u."tenantId" = $${paramIndex++}`);
      params.push(filter.tenantId);
    }

    if (filter.role) {
      whereConditions.push(`u.role = $${paramIndex++}`);
      params.push(filter.role);
    }

    if (filter.status === 'active') {
      whereConditions.push(`u."isActive" = true`);
    } else if (filter.status === 'inactive') {
      whereConditions.push(`u."isActive" = false`);
    }

    if (filter.search) {
      whereConditions.push(
        `(u.email ILIKE $${paramIndex} OR u."firstName" ILIKE $${paramIndex} OR u."lastName" ILIKE $${paramIndex})`,
      );
      params.push(`%${filter.search}%`);
      paramIndex++;
    }

    const whereClause =
      whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    // Validate sort column to prevent SQL injection
    const allowedSortColumns = [
      'createdAt',
      'email',
      'firstName',
      'lastName',
      'role',
      'lastLoginAt',
    ];
    const sortColumnMap: Record<string, string> = {
      createdAt: '"createdAt"',
      email: 'email',
      firstName: '"firstName"',
      lastName: '"lastName"',
      role: 'role',
      lastLoginAt: '"lastLoginAt"',
    };
    const sortColumn = allowedSortColumns.includes(sortBy)
      ? sortColumnMap[sortBy]
      : '"createdAt"';

    // C-2 fix: enforce safe sort order at service layer to prevent SQL injection
    const safeSortOrder = sortOrder === 'ASC' ? 'ASC' : 'DESC';

    const query = `
      SELECT
        u.id,
        u.email,
        u."firstName",
        u."lastName",
        u.role,
        u."tenantId",
        t.name as "tenantName",
        u."isActive",
        u."lastLoginAt",
        u."createdAt",
        u."updatedAt"
      FROM auth.users u
      LEFT JOIN auth.tenants t ON u."tenantId" = t.id
      ${whereClause}
      ORDER BY u.${sortColumn} ${safeSortOrder}
      LIMIT $${paramIndex++} OFFSET $${paramIndex}
    `;

    const countQuery = `
      SELECT COUNT(*) as total
      FROM auth.users u
      ${whereClause}
    `;

    try {
      const [users, countResult] = await Promise.all([
        this.dataSource.query(query, [...params, limit, offset]),
        this.dataSource.query(countQuery, params),
      ]);

      const total = parseInt(countResult[0]?.total || '0', 10);

      return createStandardPaginatedResult(users, total, page, limit);
    } catch (error) {
      this.logger.error(`Failed to list users: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Get user statistics
   */
  async getUserStats(): Promise<UserStats> {
    try {
      const [
        totalResult,
        activeResult,
        byRoleResult,
        byTenantResult,
        newUsersResult,
        loginsResult,
      ] = await Promise.all([
        this.dataSource.query(`SELECT COUNT(*) as count FROM auth.users`),
        this.dataSource.query(
          `SELECT COUNT(*) as count FROM auth.users WHERE "isActive" = true`,
        ),
        this.dataSource.query(`
          SELECT role, COUNT(*) as count
          FROM auth.users
          GROUP BY role
          ORDER BY count DESC
        `),
        this.dataSource.query(`
          SELECT u."tenantId", t.name as "tenantName", COUNT(*) as count
          FROM auth.users u
          LEFT JOIN auth.tenants t ON u."tenantId" = t.id
          WHERE u."tenantId" IS NOT NULL
          GROUP BY u."tenantId", t.name
          ORDER BY count DESC
          LIMIT 10
        `),
        this.dataSource.query(`
          SELECT COUNT(*) as count
          FROM auth.users
          WHERE "createdAt" >= NOW() - INTERVAL '30 days'
        `),
        this.dataSource.query(`
          SELECT COUNT(*) as count
          FROM auth.users
          WHERE "lastLoginAt" >= NOW() - INTERVAL '24 hours'
        `),
      ]);

      const totalUsers = parseInt(totalResult[0]?.count || '0', 10);
      const activeUsers = parseInt(activeResult[0]?.count || '0', 10);

      return {
        totalUsers,
        activeUsers,
        inactiveUsers: totalUsers - activeUsers,
        usersByRole: byRoleResult.map((r: { role: string; count: string }) => ({
          role: r.role,
          count: parseInt(r.count, 10),
        })),
        usersByTenant: byTenantResult.map(
          (r: { tenantId: string; tenantName: string; count: string }) => ({
            tenantId: r.tenantId,
            tenantName: r.tenantName,
            count: parseInt(r.count, 10),
          }),
        ),
        newUsersLast30Days: parseInt(newUsersResult[0]?.count || '0', 10),
        loginsLast24Hours: parseInt(loginsResult[0]?.count || '0', 10),
      };
    } catch (error) {
      this.logger.error(`Failed to get user stats: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Get recently active users
   */
  async getRecentlyActiveUsers(limit = 50): Promise<UserDto[]> {
    try {
      return await this.dataSource.query(
        `
        SELECT
          u.id,
          u.email,
          u."firstName",
          u."lastName",
          u.role,
          u."tenantId",
          t.name as "tenantName",
          u."isActive",
          u."lastLoginAt",
          u."createdAt"
        FROM auth.users u
        LEFT JOIN auth.tenants t ON u."tenantId" = t.id
        WHERE u."lastLoginAt" IS NOT NULL
        ORDER BY u."lastLoginAt" DESC
        LIMIT $1
      `,
        [limit],
      );
    } catch (error) {
      this.logger.error(
        `Failed to get recently active users: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Get user by ID
   */
  async getUserById(id: string): Promise<UserDto> {
    try {
      const result = await this.dataSource.query(
        `
        SELECT
          u.id,
          u.email,
          u."firstName",
          u."lastName",
          u.role,
          u."tenantId",
          t.name as "tenantName",
          u."isActive",
          u."lastLoginAt",
          u."createdAt",
          u."updatedAt"
        FROM auth.users u
        LEFT JOIN auth.tenants t ON u."tenantId" = t.id
        WHERE u.id = $1
      `,
        [id],
      );

      if (!result[0]) {
        throw new NotFoundException(`User with ID ${id} not found`);
      }

      return result[0];
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Failed to get user: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Get user's activity log
   */
  async getUserActivity(
    userId: string,
    limit = 50,
  ): Promise<UserActivity[]> {
    try {
      return await this.dataSource.query(
        `
        SELECT
          id,
          action,
          "entityType",
          "entityId",
          details AS metadata,
          "ipAddress",
          "userAgent",
          "createdAt"
        FROM auth.audit_logs
        WHERE "performedBy" = $1
        ORDER BY "createdAt" DESC
        LIMIT $2
      `,
        [userId, limit],
      );
    } catch (error) {
      this.logger.error(
        `Failed to get user activity: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Get user's active sessions
   */
  async getUserSessions(userId: string): Promise<UserSession[]> {
    try {
      return await this.dataSource.query(
        `
        SELECT
          id,
          LEFT(token, 20) || '...' as token,
          "ipAddress",
          "userAgent",
          "createdAt",
          "expiresAt",
          ("expiresAt" > NOW()) as "isActive"
        FROM auth.refresh_tokens
        WHERE "userId" = $1
        ORDER BY "createdAt" DESC
        LIMIT 50
      `,
        [userId],
      );
    } catch (error) {
      this.logger.error(
        `Failed to get user sessions: ${(error as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Create a new user.
   *
   * Delegates to auth-service over NATS (see AuthAdminNatsHandler). The
   * raw-SQL INSERT against `auth.users` was deleted here because
   * admin-api-service is NOT the owner of the auth schema — auth-service
   * is, via the `User` TypeORM entity. Writing through that entity is the
   * only way to guarantee the `password` column name and the
   * HMAC-peppered bcrypt hook stay in lock-step with the rest of the
   * authentication system. CRITICAL-001 in
   * `docs/reviews/code-reviewer/2026-04-21-raw-sql-audit.md` documents the
   * column-drift bug (`passwordHash` vs `password`) that previously lived
   * in this method; routing through NATS makes that class of bug
   * structurally impossible.
   */
  async createUser(dto: {
    email: string;
    firstName: string;
    lastName: string;
    password: string;
    role: Role;
    tenantId?: string;
  }): Promise<UserDto> {
    const command: AdminCreateUserCommand = {
      email: dto.email,
      firstName: dto.firstName,
      lastName: dto.lastName,
      password: dto.password,
      role: dto.role,
      tenantId: dto.tenantId ?? null,
    };

    const result = await this.sendAuthCommand<AdminCreateUserCommand, AdminCreateUserResult>(
      AUTH_ADMIN_COMMAND_SUBJECTS.CREATE_USER,
      command,
    );

    if (!result.success || !result.user) {
      throw this.mapCreateError(result);
    }

    // Enrich with tenantName (read-only join kept local — NOT a write path).
    let tenantName: string | null = null;
    if (result.user.tenantId) {
      tenantName = await this.getTenantName(result.user.tenantId);
    }

    // SECURITY: log user ID, not email (PII).
    this.logger.log(`Created user userId=${result.user.id}`);

    // Shape back into the REST DTO the controller exposes. updatedAt is
    // not returned by the create handler; mirror createdAt (the rows are
    // set equal at insert time).
    return {
      id: result.user.id,
      email: result.user.email,
      firstName: result.user.firstName ?? '',
      lastName: result.user.lastName ?? '',
      role: result.user.role,
      tenantId: result.user.tenantId,
      tenantName,
      isActive: result.user.isActive,
      lastLoginAt: null,
      createdAt: new Date(result.user.createdAt),
      updatedAt: new Date(result.user.createdAt),
    };
  }

  /**
   * Update user.
   *
   * Delegates to auth-service over NATS (see AuthAdminNatsHandler). The
   * raw-SQL UPDATE against `auth.users` was deleted for the same reason
   * as `createUser`: admin-api is NOT the owner of auth.users, and
   * writing column names in raw SQL is exactly the drift surface that
   * CRITICAL-001 (passwordHash) already proved dangerous. CRITICAL-002
   * (`docs/reviews/code-reviewer/2026-04-21-raw-sql-audit.md#CRITICAL-002`)
   * closes the remaining three raw-write sites in this file.
   */
  async updateUser(
    id: string,
    dto: {
      firstName?: string;
      lastName?: string;
      role?: Role;
      tenantId?: string;
      isActive?: boolean;
    },
  ): Promise<UserDto> {
    // No-op patch — short-circuit with a local read to preserve the
    // pre-existing behaviour of `updateUser(id, {})` returning the
    // current user unchanged (admin-panel relies on this).
    const patchKeys = Object.keys(dto).filter(
      (k) => (dto as Record<string, unknown>)[k] !== undefined,
    );
    if (patchKeys.length === 0) {
      return this.getUserById(id);
    }

    const command: AdminUpdateUserCommand = {
      userId: id,
      ...(dto.firstName !== undefined && { firstName: dto.firstName }),
      ...(dto.lastName !== undefined && { lastName: dto.lastName }),
      ...(dto.role !== undefined && { role: dto.role }),
      ...(dto.tenantId !== undefined && { tenantId: dto.tenantId }),
      ...(dto.isActive !== undefined && { isActive: dto.isActive }),
    };

    const result = await this.sendAuthCommand<
      AdminUpdateUserCommand,
      AdminUpdateUserResult
    >(AUTH_ADMIN_COMMAND_SUBJECTS.UPDATE_USER, command);

    if (!result.success || !result.user) {
      throw this.mapUpdateError(result);
    }

    // Tenant name is a local read (NOT a write path) — the
    // service-ownership rule only bans cross-service writes.
    let tenantName: string | null = null;
    if (result.user.tenantId) {
      tenantName = await this.getTenantName(result.user.tenantId);
    }

    this.logger.log(`Updated userId=${result.user.id}`);

    return {
      id: result.user.id,
      email: result.user.email,
      firstName: result.user.firstName ?? '',
      lastName: result.user.lastName ?? '',
      role: result.user.role,
      tenantId: result.user.tenantId,
      tenantName,
      isActive: result.user.isActive,
      lastLoginAt: result.user.lastLoginAt ? new Date(result.user.lastLoginAt) : null,
      createdAt: new Date(result.user.createdAt),
      updatedAt: new Date(result.user.updatedAt),
    };
  }

  /**
   * Set user active status
   */
  async setUserStatus(id: string, isActive: boolean): Promise<UserDto> {
    return this.updateUser(id, { isActive });
  }

  /**
   * Reset a user's password (SUPER_ADMIN out-of-band flow).
   *
   * Delegates to auth-service over NATS (see AuthAdminNatsHandler). Same
   * ownership rationale as `createUser`: auth-service owns the schema,
   * and the `User` entity's `@BeforeUpdate` hook is the only correct place
   * to apply HMAC-peppered bcrypt. The previous raw SQL targeted a
   * non-existent `passwordHash` column (CRITICAL-001) — that bug class is
   * now structurally impossible because admin-api no longer names columns.
   *
   * Side-effect on auth-service: ALL refresh tokens for the user are
   * revoked. The returned `success` flag does not surface that count
   * because the existing REST contract with the admin-panel is
   * `{ success: boolean }` only.
   */
  async resetPassword(
    id: string,
    newPassword: string,
    performedBy?: string,
  ): Promise<{ success: boolean }> {
    const command: AdminResetUserPasswordCommand = {
      userId: id,
      newPassword,
      // When invoked without an explicit actor, record the admin-api
      // service itself as the actor. A follow-up will plumb @CurrentUser
      // through the controller so this is always populated.
      performedBy: performedBy ?? 'admin-api-service',
    };

    const result = await this.sendAuthCommand<
      AdminResetUserPasswordCommand,
      AdminResetUserPasswordResult
    >(AUTH_ADMIN_COMMAND_SUBJECTS.RESET_USER_PASSWORD, command);

    if (!result.success) {
      throw this.mapResetError(result);
    }

    this.logger.log(
      `Password reset for userId=${id}, refreshTokensRevoked=${result.refreshTokensRevoked ?? 0}`,
    );
    return { success: true };
  }

  /**
   * Force logout user (invalidate all refresh tokens).
   *
   * Delegates to auth-service over NATS. admin-api must not delete rows
   * from `auth.refresh_tokens` directly — that table is owned by
   * auth-service and its columns / indexes are managed through the
   * RefreshToken TypeORM entity. CRITICAL-002 replaces the raw-SQL
   * DELETE with an `AdminForceLogoutUserCommand`.
   */
  async forceLogout(id: string): Promise<{ success: boolean; count: number }> {
    const command: AdminForceLogoutUserCommand = { userId: id };
    const result = await this.sendAuthCommand<
      AdminForceLogoutUserCommand,
      AdminForceLogoutUserResult
    >(AUTH_ADMIN_COMMAND_SUBJECTS.FORCE_LOGOUT_USER, command);

    if (!result.success) {
      throw this.mapForceLogoutError(result);
    }

    const count = result.sessionsInvalidated ?? 0;
    this.logger.log(`Force logged out userId=${id}, invalidated ${count} sessions`);
    return { success: true, count };
  }

  /**
   * Delete user (platform-scoped soft delete — sets isActive=false and
   * invalidates all sessions).
   *
   * Delegates to auth-service over NATS. The previous raw-SQL path did
   * two writes (DELETE refresh_tokens + UPDATE users); the NATS command
   * fuses both into a single auth-service transaction so the state stays
   * consistent if one half fails (admin-api used to leak "sessions
   * invalidated but user still active" when the UPDATE raced a concurrent
   * login). CRITICAL-002 fixes that too.
   */
  async deleteUser(id: string): Promise<void> {
    const command: AdminDeactivateUserCommand = {
      userId: id,
      // When the controller doesn't plumb the actor through, record the
      // service itself; audit log on auth-service captures the event.
      performedBy: 'admin-api-service',
    };
    const result = await this.sendAuthCommand<
      AdminDeactivateUserCommand,
      AdminDeactivateUserResult
    >(AUTH_ADMIN_COMMAND_SUBJECTS.DEACTIVATE_USER, command);

    if (!result.success) {
      throw this.mapDeactivateError(result);
    }

    this.logger.log(
      `Deleted (deactivated) userId=${id}, refreshTokensRemoved=${result.refreshTokensRemoved ?? 0}`,
    );
  }

  /**
   * Get tenant name by ID
   */
  async getTenantName(tenantId: string): Promise<string | null> {
    try {
      const result = await this.dataSource.query(
        `SELECT name FROM auth.tenants WHERE id = $1`,
        [tenantId],
      );
      return result?.[0]?.name || null;
    } catch (error) {
      this.logger.error(`Failed to get tenant name: ${(error as Error).message}`);
      return null;
    }
  }

  // ==========================================================================
  // NATS delegation helpers
  // ==========================================================================

  /**
   * Send a request-reply to auth-service via the shared NATS client.
   *
   * Mirrors the error-translation pattern in
   * `MessagingAdminController.sendNatsRequest` — timeouts map to 504,
   * connection issues to 503, and domain exceptions flow through as HTTP
   * exceptions so the REST layer surfaces them unchanged.
   */
  private async sendAuthCommand<TCommand, TResult>(
    subject: string,
    command: TCommand,
  ): Promise<TResult> {
    try {
      return await firstValueFrom(
        this.authNatsClient.send<TResult, TCommand>(subject, command).pipe(
          timeout(this.authNatsTimeoutMs),
          catchError((err: Error) => {
            // SECURITY: log only the subject + error message, never the
            // command payload (it contains plaintext passwords).
            this.logger.error(
              `NATS request failed: subject=${subject}, error=${err.message}`,
            );
            return throwError(() => err);
          }),
        ),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes('Timeout')) {
        throw new HttpException(
          `Auth service did not respond within ${this.authNatsTimeoutMs}ms`,
          HttpStatus.GATEWAY_TIMEOUT,
        );
      }

      if (message.includes('not connected') || message.includes('CONN_CLOSED')) {
        throw new ServiceUnavailableException(
          'Auth service is currently unavailable',
        );
      }

      if (err instanceof HttpException) throw err;
      throw new HttpException(
        `Auth service error: ${message}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  /**
   * Translate an `AdminCreateUserResult` failure code into the REST
   * exception the controller layer expects. Using a fixed vocabulary
   * keeps the NATS contract stable across future refactors on either
   * side of the boundary.
   */
  private mapCreateError(result: AdminCreateUserResult): HttpException {
    const msg = result.error ?? 'Failed to create user';
    switch (result.errorCode) {
      case 'DUPLICATE_EMAIL':
        return new ConflictException(msg);
      case 'TENANT_NOT_FOUND':
        return new NotFoundException(msg);
      case 'INVALID_ROLE':
      case 'VALIDATION_ERROR':
        return new BadRequestException(msg);
      case 'INTERNAL_ERROR':
      default:
        return new InternalServerErrorException(msg);
    }
  }

  private mapResetError(result: AdminResetUserPasswordResult): HttpException {
    const msg = result.error ?? 'Failed to reset password';
    switch (result.errorCode) {
      case 'USER_NOT_FOUND':
        return new NotFoundException(msg);
      case 'VALIDATION_ERROR':
        return new BadRequestException(msg);
      case 'INTERNAL_ERROR':
      default:
        return new InternalServerErrorException(msg);
    }
  }

  private mapUpdateError(result: AdminUpdateUserResult): HttpException {
    const msg = result.error ?? 'Failed to update user';
    switch (result.errorCode) {
      case 'USER_NOT_FOUND':
      case 'TENANT_NOT_FOUND':
        return new NotFoundException(msg);
      case 'INVALID_ROLE':
      case 'VALIDATION_ERROR':
        return new BadRequestException(msg);
      case 'INTERNAL_ERROR':
      default:
        return new InternalServerErrorException(msg);
    }
  }

  private mapDeactivateError(result: AdminDeactivateUserResult): HttpException {
    const msg = result.error ?? 'Failed to deactivate user';
    switch (result.errorCode) {
      case 'USER_NOT_FOUND':
        return new NotFoundException(msg);
      case 'VALIDATION_ERROR':
        return new BadRequestException(msg);
      case 'INTERNAL_ERROR':
      default:
        return new InternalServerErrorException(msg);
    }
  }

  private mapForceLogoutError(result: AdminForceLogoutUserResult): HttpException {
    const msg = result.error ?? 'Failed to force logout';
    switch (result.errorCode) {
      case 'USER_NOT_FOUND':
        return new NotFoundException(msg);
      case 'INTERNAL_ERROR':
      default:
        return new InternalServerErrorException(msg);
    }
  }
}
