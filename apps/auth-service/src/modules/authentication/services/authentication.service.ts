import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';

import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Role,
  TimingSafeService,
  ISessionManager,
  ITokenBlacklist,
  SESSION_MANAGER,
  TOKEN_BLACKLIST,
} from '@platform/backend-common';
import { IEventBus } from '@platform/event-bus';
import { DataSource, Repository } from 'typeorm';

import { AuditLogService, CreateAuditLogDto } from '../../../audit/audit-log.service';
import { AuditLogSeverity } from '../../../audit/audit-log.entity';
import { SECURITY_CONSTANTS, TOKEN_CONSTANTS } from '../../../constants/auth.constants';
import { AuthPayload, MePayload } from '../dto/auth-response.dto';
import { LoginInput } from '../dto/login.dto';
import { RegisterInput } from '../dto/register.dto';
import { Invitation, InvitationStatus } from '../entities/invitation.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { UserModuleAssignment } from '../entities/user-module-assignment.entity';
import { User } from '../entities/user.entity';

/**
 * Generic authentication error message
 * SECURITY: Using generic message prevents user enumeration attacks
 */
const INVALID_CREDENTIALS_MSG = 'Invalid email or password';
const GENERIC_AUTH_ERROR_MSG = 'Authentication failed';

/**
 * JWT Payload structure
 */
export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  roles: Role[];
  tenantId: string | null;
  modules?: string[];
  jti?: string; // JWT ID for blacklisting
  iat?: number;
  exp?: number;
}

/**
 * Tenant module query result row
 */
interface TenantModuleRow {
  code: string;
  name: string;
  defaultRoute: string;
}

@Injectable()
export class AuthenticationService {
  private readonly logger = new Logger(AuthenticationService.name);
  private readonly maxFailedAttempts: number;
  private readonly lockoutDurationMinutes: number;
  private readonly refreshTokenExpiryDays: number;
  private readonly maxSessionsPerUser: number;
  private readonly hashRefreshTokens: boolean;
  private readonly minLoginDurationMs: number;

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    @InjectRepository(Invitation)
    private readonly invitationRepository: Repository<Invitation>,
    @InjectRepository(UserModuleAssignment)
    private readonly userModuleAssignmentRepository: Repository<UserModuleAssignment>,
    private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Inject('EVENT_BUS') private readonly eventBus: IEventBus,
    private readonly auditLogService: AuditLogService,
    @Optional() private readonly timingSafe?: TimingSafeService,
    @Optional() @Inject(SESSION_MANAGER) private readonly sessionManager?: ISessionManager,
    @Optional() @Inject(TOKEN_BLACKLIST) private readonly tokenBlacklist?: ITokenBlacklist,
  ) {
    this.maxFailedAttempts = this.configService.get<number>(
      'MAX_FAILED_ATTEMPTS',
      SECURITY_CONSTANTS.DEFAULT_MAX_FAILED_ATTEMPTS,
    );
    this.lockoutDurationMinutes = this.configService.get<number>(
      'LOCKOUT_DURATION_MINUTES',
      SECURITY_CONSTANTS.DEFAULT_LOCKOUT_DURATION_MINUTES,
    );
    this.refreshTokenExpiryDays = this.configService.get<number>(
      'REFRESH_TOKEN_EXPIRY_DAYS',
      SECURITY_CONSTANTS.DEFAULT_REFRESH_TOKEN_EXPIRY_DAYS,
    );
    this.maxSessionsPerUser = this.configService.get<number>(
      'MAX_SESSIONS_PER_USER',
      SECURITY_CONSTANTS.DEFAULT_MAX_SESSIONS_PER_USER,
    );
    this.hashRefreshTokens = this.configService.get<boolean>('HASH_REFRESH_TOKENS', true);
    // Minimum login duration to prevent timing attacks
    this.minLoginDurationMs = this.configService.get<number>(
      'MIN_LOGIN_DURATION_MS',
      SECURITY_CONSTANTS.MIN_LOGIN_DURATION_MS,
    );
  }

  /**
   * Log security events for audit trail
   * @private
   */
  private async logSecurityEvent(
    action: string,
    details: {
      userId?: string;
      email?: string;
      tenantId?: string | null;
      ipAddress?: string;
      userAgent?: string;
      success: boolean;
      reason?: string;
    },
    severity: AuditLogSeverity = AuditLogSeverity.INFO,
  ): Promise<void> {
    try {
      await this.auditLogService.log({
        tenantId: details.tenantId || undefined,
        performedBy: details.userId || 'anonymous',
        performedByEmail: details.email,
        action,
        entityType: 'User',
        entityId: details.userId,
        details: {
          success: details.success,
          reason: details.reason,
          timestamp: new Date().toISOString(),
        },
        severity,
        ipAddress: details.ipAddress,
        userAgent: details.userAgent,
      });
    } catch (error) {
      // Don't fail the main operation if audit logging fails
      this.logger.error(`Failed to log security event: ${action}`, error);
    }
  }

  /**
   * Register a new user (self-registration - typically not used in enterprise)
   *
   * SECURITY:
   * - Generic error message to prevent email enumeration
   * - Rate limited at controller level
   */
  async register(input: RegisterInput): Promise<AuthPayload> {
    // Check if user already exists
    const existingUser = await this.userRepository.findOne({
      where: { email: input.email.toLowerCase() },
    });

    if (existingUser) {
      // SECURITY: Generic message to prevent email enumeration
      // In production, you might want to silently fail or send email instead
      this.logger.debug(`Registration attempt for existing email: ${input.email}`);
      throw new ConflictException('Registration failed. Please try again or contact support.');
    }

    // Create new user with MODULE_USER role
    const user = this.userRepository.create({
      email: input.email.toLowerCase(),
      password: input.password,
      firstName: input.firstName,
      lastName: input.lastName,
      tenantId: input.tenantId,
      role: Role.MODULE_USER,
      isEmailVerified: false,
    });

    const savedUser = await this.userRepository.save(user);
    this.logger.log(`User registered: ${savedUser.email} in tenant ${savedUser.tenantId}`);

    // Publish event
    await this.eventBus.publish({
      eventId: crypto.randomUUID(),
      eventType: 'UserRegistered',
      timestamp: new Date(),
      tenantId: savedUser.tenantId ?? undefined,
      userId: savedUser.id,
    });

    return this.generateTokens(savedUser);
  }

  /**
   * Login user - supports all roles including SUPER_ADMIN
   *
   * SECURITY:
   * - Uses timing-safe operations to prevent timing attacks
   * - Generic error messages to prevent user enumeration
   * - Session management with concurrent session limits
   */
  async login(input: LoginInput, ipAddress?: string, userAgent?: string): Promise<AuthPayload> {
    const startTime = Date.now();
    this.logger.debug(`Login attempt for: ${input.email.toLowerCase()}`);

    try {
      // Find user by email only (tenantId can be null for SUPER_ADMIN)
      const user = await this.userRepository.findOne({
        where: { email: input.email.toLowerCase() },
      });

      // SECURITY: Perform dummy password check even if user not found
      // This prevents timing-based user enumeration
      if (!user) {
        // Simulate password check timing
        await bcrypt.compare(input.password, '$2a$12$dummy.hash.to.prevent.timing.attacks');
        await this.ensureMinDuration(startTime);
        this.logger.debug(`Login failed: user not found`);
        // SECURITY AUDIT: Log failed login attempt
        await this.logSecurityEvent('LOGIN_FAILED', {
          email: input.email,
          ipAddress,
          userAgent,
          success: false,
          reason: 'User not found',
        }, AuditLogSeverity.WARNING);
        throw new UnauthorizedException(INVALID_CREDENTIALS_MSG);
      }

      // Check if user is pending invitation (no password set)
      // SECURITY: Use generic message
      if (user.isPendingInvitation()) {
        await this.ensureMinDuration(startTime);
        this.logger.debug(`Login failed: pending invitation for ${user.email}`);
        throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
      }

      // Check if account is locked
      // SECURITY: Don't reveal lockout duration to prevent timing attacks
      if (user.isLocked()) {
        await this.ensureMinDuration(startTime);
        this.logger.debug(`Login failed: account locked for ${user.email}`);
        // SECURITY AUDIT: Log locked account access attempt
        await this.logSecurityEvent('LOGIN_BLOCKED_ACCOUNT_LOCKED', {
          userId: user.id,
          email: user.email,
          tenantId: user.tenantId,
          ipAddress,
          userAgent,
          success: false,
          reason: 'Account locked due to failed attempts',
        }, AuditLogSeverity.WARNING);
        throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
      }

      // Check if account is active
      if (!user.isActive) {
        await this.ensureMinDuration(startTime);
        this.logger.debug(`Login failed: account inactive for ${user.email}`);
        throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
      }

      // Validate password
      const isPasswordValid = await user.validatePassword(input.password);

      if (!isPasswordValid) {
        await this.handleFailedLogin(user);
        await this.ensureMinDuration(startTime);
        // SECURITY AUDIT: Log failed password attempt
        await this.logSecurityEvent('LOGIN_FAILED_INVALID_PASSWORD', {
          userId: user.id,
          email: user.email,
          tenantId: user.tenantId,
          ipAddress,
          userAgent,
          success: false,
          reason: `Invalid password (attempt ${user.failedLoginAttempts})`,
        }, AuditLogSeverity.WARNING);
        throw new UnauthorizedException(INVALID_CREDENTIALS_MSG);
      }

      // Reset failed attempts on successful login
      user.failedLoginAttempts = 0;
      user.lockedUntil = null;
      user.lastLoginAt = new Date();
      user.lastLoginIp = ipAddress ?? null;
      await this.userRepository.save(user);

      // Enforce concurrent session limit
      if (this.sessionManager) {
        await this.sessionManager.enforceSessionLimit(user.id, this.maxSessionsPerUser);
      }

      this.logger.log(`User logged in: ${user.email} (role: ${user.role})`);

      // SECURITY AUDIT: Log successful login
      await this.logSecurityEvent('LOGIN_SUCCESS', {
        userId: user.id,
        email: user.email,
        tenantId: user.tenantId,
        ipAddress,
        userAgent,
        success: true,
      });

      // Publish event
      await this.eventBus.publish({
        eventId: crypto.randomUUID(),
        eventType: 'UserLoggedIn',
        timestamp: new Date(),
        tenantId: user.tenantId ?? undefined,
        userId: user.id,
      });

      await this.ensureMinDuration(startTime);
      return this.generateTokens(user, ipAddress, userAgent);
    } catch (error) {
      await this.ensureMinDuration(startTime);
      throw error;
    }
  }

  /**
   * Ensure minimum duration to prevent timing attacks
   */
  private async ensureMinDuration(startTime: number): Promise<void> {
    if (this.timingSafe) {
      await this.timingSafe.ensureMinDuration(startTime, this.minLoginDurationMs);
    } else {
      // Fallback implementation
      const elapsed = Date.now() - startTime;
      const remaining = this.minLoginDurationMs - elapsed;
      if (remaining > 0) {
        await new Promise(resolve => setTimeout(resolve, remaining));
      }
    }
  }

  /**
   * Accept invitation and set password
   * Uses transaction to ensure user and invitation updates are atomic
   */
  async acceptInvitation(
    token: string,
    password: string,
    firstName?: string,
    lastName?: string,
    ipAddress?: string,
  ): Promise<AuthPayload> {
    // Find and validate invitation before starting transaction
    const invitation = await this.invitationRepository.findOne({
      where: { token },
    });

    if (!invitation) {
      throw new BadRequestException('Invalid invitation token');
    }

    if (!invitation.canBeAccepted()) {
      if (invitation.isExpired()) {
        throw new BadRequestException('Invitation has expired');
      }
      throw new BadRequestException('Invitation cannot be accepted');
    }

    // Find user by invitation token
    const user = await this.userRepository.findOne({
      where: { invitationToken: token },
    });

    if (!user) {
      // SECURITY: Generic message to prevent token enumeration
      throw new BadRequestException('Invalid or expired invitation');
    }

    // Execute updates in a transaction to ensure consistency
    await this.dataSource.transaction(async (manager) => {
      // Update user with password and clear invitation token
      user.password = password; // Will be hashed by BeforeUpdate hook
      user.invitationToken = null;
      user.invitationExpiresAt = null;
      user.isEmailVerified = true;

      if (firstName) user.firstName = firstName;
      if (lastName) user.lastName = lastName;

      await manager.save(User, user);

      // Update invitation status
      invitation.status = InvitationStatus.ACCEPTED;
      invitation.acceptedAt = new Date();
      invitation.userId = user.id;
      invitation.acceptedFromIp = ipAddress ?? null;
      await manager.save(Invitation, invitation);
    });

    this.logger.log(`Invitation accepted: ${user.email} (role: ${user.role})`);

    // Publish event (outside transaction - events can be retried)
    await this.eventBus.publish({
      eventId: crypto.randomUUID(),
      eventType: 'InvitationAccepted',
      timestamp: new Date(),
      tenantId: user.tenantId ?? undefined,
      userId: user.id,
    });

    return this.generateTokens(user, ipAddress);
  }

  /**
   * Validate invitation token
   */
  async validateInvitation(token: string): Promise<{
    valid: boolean;
    email?: string;
    role?: Role;
    firstName?: string;
    lastName?: string;
    expired?: boolean;
  }> {
    const invitation = await this.invitationRepository.findOne({
      where: { token },
    });

    if (!invitation) {
      return { valid: false };
    }

    if (invitation.isExpired()) {
      return { valid: false, expired: true };
    }

    if (!invitation.isPending()) {
      return { valid: false };
    }

    return {
      valid: true,
      email: invitation.email,
      role: invitation.role,
      firstName: invitation.firstName ?? undefined,
      lastName: invitation.lastName ?? undefined,
    };
  }

  /**
   * Refresh access token using a valid refresh token.
   *
   * SECURITY:
   * - Supports hashed refresh tokens
   * - Uses atomic update to prevent race conditions
   * - Implements refresh token rotation
   */
  async refreshToken(token: string): Promise<AuthPayload> {
    // If tokens are hashed, we need to find by comparing hashes
    if (this.hashRefreshTokens) {
      return this.refreshTokenWithHash(token);
    }

    // SECURITY: Use transaction with pessimistic locking to prevent double-spending
    // NOTE: FOR UPDATE cannot be used with LEFT JOIN in PostgreSQL, so we split
    // the token lock and user fetch into separate queries.
    return this.dataSource.transaction(async (manager) => {
      const tokenRepo = manager.getRepository(RefreshToken);

      // SELECT FOR UPDATE to lock the token row and prevent concurrent refresh
      const refreshToken = await tokenRepo
        .createQueryBuilder('rt')
        .setLock('pessimistic_write')
        .where('rt.token = :token', { token })
        .andWhere('rt.isRevoked = :isRevoked', { isRevoked: false })
        .andWhere('rt.expiresAt > :now', { now: new Date() })
        .getOne();

      if (!refreshToken) {
        throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
      }

      // Fetch the associated user separately (no lock needed on user row)
      const user = await manager
        .getRepository(User)
        .findOne({ where: { id: refreshToken.userId } });

      if (!user || !user.isActive) {
        throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
      }

      // Revoke the token within the same transaction
      refreshToken.isRevoked = true;
      refreshToken.revokedAt = new Date();
      refreshToken.revokedReason = 'Token refreshed';
      await tokenRepo.save(refreshToken);

      return this.generateTokens(
        user,
        refreshToken.ipAddress ?? undefined,
        refreshToken.userAgent ?? undefined,
      );
    });
  }

  /**
   * Refresh token with hashed tokens
   * Since we can't query by hash directly, we need to find valid tokens
   * for the user and compare hashes
   *
   * SECURITY: Uses transaction with pessimistic locking to prevent double-spending
   */
  private async refreshTokenWithHash(plainToken: string): Promise<AuthPayload> {
    return this.dataSource.transaction(async (manager) => {
      const tokenRepo = manager.getRepository(RefreshToken);

      // Get all non-revoked, non-expired tokens with pessimistic lock
      // NOTE: No LEFT JOIN here — FOR UPDATE cannot be applied to outer join targets in PostgreSQL
      const validTokens = await tokenRepo
        .createQueryBuilder('rt')
        .setLock('pessimistic_write')
        .where('rt.isRevoked = :isRevoked', { isRevoked: false })
        .andWhere('rt.expiresAt > :now', { now: new Date() })
        .orderBy('rt.createdAt', 'DESC')
        .take(TOKEN_CONSTANTS.MAX_REFRESH_TOKEN_CHECK)
        .getMany();

      // Find matching token by comparing hashes
      let matchedToken: RefreshToken | null = null;
      for (const storedToken of validTokens) {
        const isMatch = await bcrypt.compare(plainToken, storedToken.token);
        if (isMatch) {
          matchedToken = storedToken;
          break;
        }
      }

      if (!matchedToken) {
        throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
      }

      // Double-check the token is still not revoked (within locked transaction)
      if (matchedToken.isRevoked) {
        throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
      }

      // Fetch the associated user separately
      const user = await manager
        .getRepository(User)
        .findOne({ where: { id: matchedToken.userId } });

      if (!user || !user.isActive) {
        throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
      }

      // Revoke the token within the same transaction
      matchedToken.isRevoked = true;
      matchedToken.revokedAt = new Date();
      matchedToken.revokedReason = 'Token refreshed';
      await tokenRepo.save(matchedToken);

      return this.generateTokens(
        user,
        matchedToken.ipAddress ?? undefined,
        matchedToken.userAgent ?? undefined,
      );
    });
  }

  /**
   * Logout user
   *
   * - Revokes all refresh tokens
   * - Blacklists current access token (if JTI provided)
   * - Revokes all sessions
   */
  async logout(userId: string, jti?: string, accessTokenExpiry?: Date): Promise<boolean> {
    // Revoke all refresh tokens for user
    await this.refreshTokenRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true, revokedAt: new Date(), revokedReason: 'User logged out' },
    );

    // Blacklist current access token if JTI provided
    if (jti && accessTokenExpiry && this.tokenBlacklist) {
      await this.tokenBlacklist.add(jti, accessTokenExpiry, 'user_logout');
    }

    // Revoke all sessions
    if (this.sessionManager) {
      await this.sessionManager.revokeAllSessions(userId);
    }

    this.logger.log(`User logged out: ${userId}`);
    return true;
  }

  /**
   * Logout from all devices
   */
  async logoutAllDevices(userId: string): Promise<number> {
    // Revoke all refresh tokens
    const result = await this.refreshTokenRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true, revokedAt: new Date(), revokedReason: 'Logged out from all devices' },
    );

    // Blacklist all user tokens
    if (this.tokenBlacklist) {
      const expiresIn = this.configService.get<string>('JWT_EXPIRES_IN', '15m');
      const expiresInSeconds = this.parseExpiresIn(expiresIn);
      const expiryDate = new Date(Date.now() + expiresInSeconds * 1000);
      await this.tokenBlacklist.blacklistUserTokens(userId, expiryDate, 'logout_all_devices');
    }

    // Revoke all sessions
    if (this.sessionManager) {
      await this.sessionManager.revokeAllSessions(userId);
    }

    this.logger.log(`User logged out from all devices: ${userId}`);
    return result.affected || 0;
  }

  /**
   * Validate access token
   *
   * SECURITY:
   * - Verifies JWT signature
   * - Checks token blacklist
   * - Validates token hasn't expired
   */
  async validateToken(token: string): Promise<{ valid: boolean; payload?: JwtPayload }> {
    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);

      // Check if token is blacklisted (by JTI or user-level blacklist)
      if (this.tokenBlacklist && payload.jti) {
        const isBlacklisted = await this.tokenBlacklist.isBlacklisted(payload.jti);
        if (isBlacklisted) {
          this.logger.debug(`Token blacklisted: ${payload.jti}`);
          return { valid: false };
        }

        // Check user-level blacklist
        if (payload.iat) {
          const tokenIssuedAt = new Date(payload.iat * 1000);
          const isUserBlacklisted = await this.tokenBlacklist.isUserBlacklisted(
            payload.sub,
            tokenIssuedAt,
          );
          if (isUserBlacklisted) {
            this.logger.debug(`User tokens blacklisted: ${payload.sub}`);
            return { valid: false };
          }
        }
      }

      return { valid: true, payload };
    } catch (error) {
      this.logger.debug(`Token validation failed: ${(error as Error).message}`);
      return { valid: false };
    }
  }

  /**
   * Get current user with their accessible modules
   */
  async me(userId: string): Promise<MePayload> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      // SECURITY: Generic message to prevent information leakage
      throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
    }

    // Get user's accessible modules
    const modules = await this.getUserModules(user);

    // Determine redirect path based on role
    let redirectPath: string;
    switch (user.role) {
      case Role.SUPER_ADMIN:
        redirectPath = '/admin/dashboard';
        break;
      case Role.TENANT_ADMIN:
        redirectPath = '/tenant/dashboard';
        break;
      case Role.MODULE_MANAGER:
      case Role.MODULE_USER:
        // Redirect to first/primary module
        if (modules.length > 0 && modules[0]) {
          redirectPath = modules[0].defaultRoute;
        } else {
          redirectPath = '/no-access';
        }
        break;
      default:
        redirectPath = '/';
    }

    return {
      user,
      modules,
      redirectPath,
    };
  }

  async getUserById(userId: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { id: userId },
    });
  }

  /**
   * Get modules accessible by user based on their role
   */
  private async getUserModules(user: User): Promise<Array<{ code: string; name: string; defaultRoute: string }>> {
    // SUPER_ADMIN has no modules (they manage the system)
    if (user.role === Role.SUPER_ADMIN) {
      return [];
    }

    // TENANT_ADMIN has access to all tenant modules
    if (user.role === Role.TENANT_ADMIN && user.tenantId) {
      // Query tenant_modules join with modules to get all modules for this tenant
      const tenantModules = await this.userRepository.manager.query<TenantModuleRow[]>(
        `SELECT m.code, m.name, m."defaultRoute"
         FROM auth.tenant_modules tm
         JOIN auth.modules m ON tm."moduleId" = m.id
         WHERE tm."tenantId" = $1 AND tm."isEnabled" = true
         ORDER BY m.name`,
        [user.tenantId],
      );

      return tenantModules.map((tm) => ({
        code: tm.code,
        name: tm.name,
        defaultRoute: tm.defaultRoute,
      }));
    }

    // MODULE_MANAGER and MODULE_USER have specific module assignments
    const assignments = await this.userModuleAssignmentRepository.find({
      where: { userId: user.id, isActive: true },
      relations: ['module'],
    });

    return assignments
      .filter((a) => a.isAccessible() && a.module)
      .map((a) => ({
        code: a.module.code,
        name: a.module.name,
        defaultRoute: a.module.defaultRoute,
      }));
  }

  /**
   * Handle failed login with atomic database increment to prevent race conditions.
   * Uses raw SQL to ensure atomicity even under concurrent login attempts.
   */
  private async handleFailedLogin(user: User): Promise<void> {
    // Atomic increment using raw query to prevent race conditions
    // This ensures concurrent failed login attempts are all counted
    await this.userRepository
      .createQueryBuilder()
      .update(User)
      .set({
        failedLoginAttempts: () => '"failedLoginAttempts" + 1',
      })
      .where('id = :id', { id: user.id })
      .execute();

    // Re-fetch to check current count and apply lockout if needed
    const updatedUser = await this.userRepository.findOne({
      where: { id: user.id },
      select: ['id', 'email', 'failedLoginAttempts'],
    });

    if (updatedUser && updatedUser.failedLoginAttempts >= this.maxFailedAttempts) {
      const lockoutUntil = new Date(Date.now() + this.lockoutDurationMinutes * 60 * 1000);
      await this.userRepository.update(user.id, { lockedUntil: lockoutUntil });
      this.logger.warn(`Account locked for user: ${user.email} until ${lockoutUntil.toISOString()}`);
      // SECURITY AUDIT: Log account lockout (critical security event)
      await this.logSecurityEvent('ACCOUNT_LOCKED', {
        userId: user.id,
        email: user.email,
        tenantId: user.tenantId,
        success: false,
        reason: `Account locked after ${this.maxFailedAttempts} failed attempts. Locked until ${lockoutUntil.toISOString()}`,
      }, AuditLogSeverity.CRITICAL);
    }
  }

  private async generateTokens(
    user: User,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthPayload> {
    // Get user's module codes for JWT
    const modules = await this.getUserModules(user);
    const moduleCodes = modules.map((m) => m.code);

    // Generate JWT ID for token blacklisting
    const jti = crypto.randomUUID();

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      roles: [user.role], // Include as array for consistency
      tenantId: user.tenantId ?? null,
      modules: moduleCodes.length > 0 ? moduleCodes : undefined,
      jti, // Include JTI for token blacklisting
    };

    const accessToken = await this.jwtService.signAsync(payload);
    const refreshTokenValue = crypto.randomBytes(64).toString('hex');

    // SECURITY: Hash refresh token before storage
    // The client gets the plain token, we store the hash
    let tokenToStore = refreshTokenValue;
    if (this.hashRefreshTokens) {
      tokenToStore = await bcrypt.hash(refreshTokenValue, SECURITY_CONSTANTS.BCRYPT_SALT_ROUNDS);
    }

    // Create refresh token
    const refreshToken = this.refreshTokenRepository.create({
      token: tokenToStore,
      userId: user.id,
      tenantId: user.tenantId,
      expiresAt: new Date(Date.now() + this.refreshTokenExpiryDays * 24 * 60 * 60 * 1000),
      ipAddress,
      userAgent,
    });

    await this.refreshTokenRepository.save(refreshToken);

    // Create session if session manager is available
    if (this.sessionManager) {
      await this.sessionManager.createSession(user.id, {
        ipAddress,
        userAgent,
        tenantId: user.tenantId ?? undefined,
      });
    }

    const expiresIn = this.configService.get<string>('JWT_EXPIRES_IN', '15m');
    const expiresInSeconds = this.parseExpiresIn(expiresIn);

    // Determine redirect URL based on role
    const redirectUrl = this.getRedirectUrl(user, modules);

    return {
      accessToken,
      refreshToken: refreshTokenValue, // Return plain token to client
      user,
      expiresIn: expiresInSeconds,
      tokenType: 'Bearer',
      redirectUrl,
    };
  }

  /**
   * Get redirect URL based on user role
   */
  private getRedirectUrl(
    user: User,
    modules: Array<{ code: string; name: string; defaultRoute: string }>,
  ): string {
    switch (user.role) {
      case Role.SUPER_ADMIN:
        return '/admin';
      case Role.TENANT_ADMIN:
        return '/tenant';
      case Role.MODULE_MANAGER:
      case Role.MODULE_USER:
        // Redirect to first/primary module
        if (modules.length > 0 && modules[0]) {
          return modules[0].defaultRoute;
        }
        return '/no-access';
      default:
        return '/';
    }
  }

  private parseExpiresIn(expiresIn: string): number {
    const match = expiresIn.match(/^(\d+)([smhd])$/);
    if (!match || !match[1] || !match[2]) return SECURITY_CONSTANTS.DEFAULT_JWT_EXPIRES_SECONDS;

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case 's':
        return value;
      case 'm':
        return value * 60;
      case 'h':
        return value * 60 * 60;
      case 'd':
        return value * 24 * 60 * 60;
      default:
        return SECURITY_CONSTANTS.DEFAULT_JWT_EXPIRES_SECONDS;
    }
  }
}
