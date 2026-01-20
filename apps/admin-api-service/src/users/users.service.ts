import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as bcryptjs from 'bcryptjs';

export interface UserFilter {
  tenantId?: string;
  role?: string;
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
  data: UserDto[];
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

export interface UserActivity {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
  ipAddress: string;
  userAgent: string;
  createdAt: Date;
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

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * List all users with filtering and pagination
   */
  async listUsers(
    filter: UserFilter,
    page: number = 1,
    limit: number = 20,
    sortBy: string = 'createdAt',
    sortOrder: 'ASC' | 'DESC' = 'DESC',
  ): Promise<PaginatedUsers> {
    const offset = (page - 1) * limit;

    let whereConditions: string[] = [];
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
      FROM users u
      LEFT JOIN tenants t ON u."tenantId" = t.id
      ${whereClause}
      ORDER BY u.${sortColumn} ${sortOrder}
      LIMIT $${paramIndex++} OFFSET $${paramIndex}
    `;

    const countQuery = `
      SELECT COUNT(*) as total
      FROM users u
      ${whereClause}
    `;

    try {
      const [users, countResult] = await Promise.all([
        this.dataSource.query(query, [...params, limit, offset]),
        this.dataSource.query(countQuery, params),
      ]);

      const total = parseInt(countResult[0]?.total || '0', 10);

      return {
        data: users,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
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
        this.dataSource.query(`SELECT COUNT(*) as count FROM users`),
        this.dataSource.query(
          `SELECT COUNT(*) as count FROM users WHERE "isActive" = true`,
        ),
        this.dataSource.query(`
          SELECT role, COUNT(*) as count
          FROM users
          GROUP BY role
          ORDER BY count DESC
        `),
        this.dataSource.query(`
          SELECT u."tenantId", t.name as "tenantName", COUNT(*) as count
          FROM users u
          LEFT JOIN tenants t ON u."tenantId" = t.id
          WHERE u."tenantId" IS NOT NULL
          GROUP BY u."tenantId", t.name
          ORDER BY count DESC
          LIMIT 10
        `),
        this.dataSource.query(`
          SELECT COUNT(*) as count
          FROM users
          WHERE "createdAt" >= NOW() - INTERVAL '30 days'
        `),
        this.dataSource.query(`
          SELECT COUNT(*) as count
          FROM users
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
  async getRecentlyActiveUsers(limit: number = 50): Promise<UserDto[]> {
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
        FROM users u
        LEFT JOIN tenants t ON u."tenantId" = t.id
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
        FROM users u
        LEFT JOIN tenants t ON u."tenantId" = t.id
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
    limit: number = 50,
  ): Promise<UserActivity[]> {
    try {
      return await this.dataSource.query(
        `
        SELECT
          id,
          action,
          "entityType",
          "entityId",
          metadata,
          "ipAddress",
          "userAgent",
          "createdAt"
        FROM audit_logs
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
      return [];
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
        FROM refresh_tokens
        WHERE "userId" = $1
        ORDER BY "createdAt" DESC
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
   * Create new user
   */
  async createUser(dto: {
    email: string;
    firstName: string;
    lastName: string;
    password: string;
    role: string;
    tenantId?: string;
  }): Promise<UserDto> {
    try {
      const hashedPassword = await bcryptjs.hash(dto.password, 12);

      const result = await this.dataSource.query(
        `
        INSERT INTO users (email, "firstName", "lastName", "passwordHash", role, "tenantId", "isActive")
        VALUES ($1, $2, $3, $4, $5, $6, true)
        RETURNING id, email, "firstName", "lastName", role,
                  "tenantId", "isActive", "createdAt"
      `,
        [
          dto.email.toLowerCase(),
          dto.firstName,
          dto.lastName,
          hashedPassword,
          dto.role,
          dto.tenantId || null,
        ],
      );

      this.logger.log(`Created user: ${dto.email}`);
      return result[0];
    } catch (error) {
      this.logger.error(`Failed to create user: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Update user
   */
  async updateUser(
    id: string,
    dto: {
      firstName?: string;
      lastName?: string;
      role?: string;
      tenantId?: string;
      isActive?: boolean;
    },
  ): Promise<UserDto> {
    const updates: string[] = [];
    const params: (string | boolean)[] = [];
    let paramIndex = 1;

    if (dto.firstName !== undefined) {
      updates.push(`"firstName" = $${paramIndex++}`);
      params.push(dto.firstName);
    }
    if (dto.lastName !== undefined) {
      updates.push(`"lastName" = $${paramIndex++}`);
      params.push(dto.lastName);
    }
    if (dto.role !== undefined) {
      updates.push(`role = $${paramIndex++}`);
      params.push(dto.role);
    }
    if (dto.tenantId !== undefined) {
      updates.push(`"tenantId" = $${paramIndex++}`);
      params.push(dto.tenantId);
    }
    if (dto.isActive !== undefined) {
      updates.push(`"isActive" = $${paramIndex++}`);
      params.push(dto.isActive);
    }

    if (updates.length === 0) {
      return this.getUserById(id);
    }

    updates.push(`"updatedAt" = NOW()`);
    params.push(id);

    try {
      const result = await this.dataSource.query(
        `
        UPDATE users
        SET ${updates.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING id, email, "firstName", "lastName", role,
                  "tenantId", "isActive",
                  "createdAt", "updatedAt"
      `,
        params,
      );

      if (!result[0]) {
        throw new NotFoundException(`User with ID ${id} not found`);
      }

      this.logger.log(`Updated user: ${id}`);
      return result[0];
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Failed to update user: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Set user active status
   */
  async setUserStatus(id: string, isActive: boolean): Promise<UserDto> {
    return this.updateUser(id, { isActive });
  }

  /**
   * Reset user password
   */
  async resetPassword(
    id: string,
    newPassword: string,
  ): Promise<{ success: boolean }> {
    try {
      const hashedPassword = await bcryptjs.hash(newPassword, 12);

      const result = await this.dataSource.query(
        `
        UPDATE users
        SET "passwordHash" = $1, "updatedAt" = NOW()
        WHERE id = $2
        RETURNING id
      `,
        [hashedPassword, id],
      );

      if (!result[0]) {
        throw new NotFoundException(`User with ID ${id} not found`);
      }

      this.logger.log(`Password reset for user: ${id}`);
      return { success: true };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Failed to reset password: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Force logout user (invalidate all refresh tokens)
   */
  async forceLogout(id: string): Promise<{ success: boolean; count: number }> {
    try {
      const result = await this.dataSource.query(
        `DELETE FROM refresh_tokens WHERE "userId" = $1`,
        [id],
      );

      const count = result[1] || 0;
      this.logger.log(`Force logged out user: ${id}, invalidated ${count} sessions`);
      return { success: true, count };
    } catch (error) {
      this.logger.error(`Failed to force logout: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Delete user (soft delete - deactivate)
   */
  async deleteUser(id: string): Promise<void> {
    try {
      // First invalidate all sessions
      await this.forceLogout(id);

      // Soft delete by deactivating
      const result = await this.dataSource.query(
        `
        UPDATE users
        SET "isActive" = false, "updatedAt" = NOW()
        WHERE id = $1
        RETURNING id
      `,
        [id],
      );

      if (!result[0]) {
        throw new NotFoundException(`User with ID ${id} not found`);
      }

      this.logger.log(`Deleted (deactivated) user: ${id}`);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Failed to delete user: ${(error as Error).message}`);
      throw error;
    }
  }

  private camelToSnake(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  }
}
