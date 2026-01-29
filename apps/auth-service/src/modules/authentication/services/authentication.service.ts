import * as crypto from 'crypto';

import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  Inject,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Role } from '@platform/backend-common';
import { IEventBus } from '@platform/event-bus';
import { DataSource, Repository } from 'typeorm';

import { AuthPayload, MePayload } from '../dto/auth-response.dto';
import { LoginInput } from '../dto/login.dto';
import { RegisterInput } from '../dto/register.dto';
import { Invitation, InvitationStatus } from '../entities/invitation.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { UserModuleAssignment } from '../entities/user-module-assignment.entity';
import { User } from '../entities/user.entity';


/**
 * JWT Payload structure
 */
export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  tenantId: string | null;
  modules?: string[];
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
  ) {
    this.maxFailedAttempts = this.configService.get<number>('MAX_FAILED_ATTEMPTS', 5);
    this.lockoutDurationMinutes = this.configService.get<number>('LOCKOUT_DURATION_MINUTES', 30);
    this.refreshTokenExpiryDays = this.configService.get<number>('REFRESH_TOKEN_EXPIRY_DAYS', 7);
  }

  /**
   * Register a new user (self-registration - typically not used in enterprise)
   */
  async register(input: RegisterInput): Promise<AuthPayload> {
    // Check if user already exists
    const existingUser = await this.userRepository.findOne({
      where: { email: input.email.toLowerCase() },
    });

    if (existingUser) {
      throw new ConflictException('User with this email already exists');
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
   */
  async login(input: LoginInput, ipAddress?: string, userAgent?: string): Promise<AuthPayload> {
    this.logger.debug(`Login attempt for: ${input.email.toLowerCase()}`);

    // Find user by email only (tenantId can be null for SUPER_ADMIN)
    const user = await this.userRepository.findOne({
      where: { email: input.email.toLowerCase() },
    });

    if (!user) {
      this.logger.debug(`User not found: ${input.email.toLowerCase()}`);
      throw new UnauthorizedException('Invalid credentials');
    }

    this.logger.debug(`User found: ${user.email}, role: ${user.role}`);

    // Check if user is pending invitation (no password set)
    if (user.isPendingInvitation()) {
      this.logger.debug(`User pending invitation: ${user.email}`);
      throw new UnauthorizedException('Please accept your invitation first');
    }

    // Check if account is locked
    if (user.isLocked()) {
      this.logger.debug(`Account locked: ${user.email}`);
      throw new UnauthorizedException(
        `Account is locked. Try again after ${user.lockedUntil?.toISOString()}`,
      );
    }

    // Check if account is active
    if (!user.isActive) {
      this.logger.debug(`Account not active: ${user.email}`);
      throw new UnauthorizedException('Account is deactivated');
    }

    // Validate password
    const isPasswordValid = await user.validatePassword(input.password);

    if (!isPasswordValid) {
      await this.handleFailedLogin(user);
      throw new UnauthorizedException('Invalid credentials');
    }

    // Reset failed attempts on successful login
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    user.lastLoginAt = new Date();
    user.lastLoginIp = ipAddress ?? null;
    await this.userRepository.save(user);

    this.logger.log(`User logged in: ${user.email} (role: ${user.role})`);

    // Publish event
    await this.eventBus.publish({
      eventId: crypto.randomUUID(),
      eventType: 'UserLoggedIn',
      timestamp: new Date(),
      tenantId: user.tenantId ?? undefined,
      userId: user.id,
    });

    return this.generateTokens(user, ipAddress, userAgent);
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
      throw new BadRequestException('User not found for this invitation');
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
   * Uses atomic update to prevent race conditions where the same token
   * could be used multiple times concurrently.
   */
  async refreshToken(token: string): Promise<AuthPayload> {
    // First, atomically try to revoke the token
    // Only succeeds if the token exists and is not already revoked
    const updateResult = await this.refreshTokenRepository
      .createQueryBuilder()
      .update(RefreshToken)
      .set({
        isRevoked: true,
        revokedAt: new Date(),
        revokedReason: 'Token refreshed',
      })
      .where('token = :token', { token })
      .andWhere('isRevoked = :isRevoked', { isRevoked: false })
      .andWhere('expiresAt > :now', { now: new Date() })
      .execute();

    // If no rows were updated, the token was invalid, already used, or expired
    if (updateResult.affected === 0) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Now safely fetch the token with user relation
    const refreshToken = await this.refreshTokenRepository.findOne({
      where: { token },
      relations: ['user'],
    });

    if (!refreshToken || !refreshToken.user) {
      // This should not happen since we just updated the row
      throw new UnauthorizedException('Refresh token data not found');
    }

    // Generate new tokens
    return this.generateTokens(
      refreshToken.user,
      refreshToken.ipAddress ?? undefined,
      refreshToken.userAgent ?? undefined,
    );
  }

  async logout(userId: string): Promise<boolean> {
    // Revoke all refresh tokens for user
    await this.refreshTokenRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true, revokedAt: new Date(), revokedReason: 'User logged out' },
    );

    this.logger.log(`User logged out: ${userId}`);
    return true;
  }

  async validateToken(token: string): Promise<{ valid: boolean; payload?: JwtPayload }> {
    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      return { valid: true, payload };
    } catch {
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
      throw new UnauthorizedException('User not found');
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
         FROM tenant_modules tm
         JOIN modules m ON tm."moduleId" = m.id
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

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId ?? null,
      modules: moduleCodes.length > 0 ? moduleCodes : undefined,
    };

    const accessToken = await this.jwtService.signAsync(payload);
    const refreshTokenValue = crypto.randomBytes(64).toString('hex');

    // Create refresh token
    const refreshToken = this.refreshTokenRepository.create({
      token: refreshTokenValue,
      userId: user.id,
      tenantId: user.tenantId,
      expiresAt: new Date(Date.now() + this.refreshTokenExpiryDays * 24 * 60 * 60 * 1000),
      ipAddress,
      userAgent,
    });

    await this.refreshTokenRepository.save(refreshToken);

    const expiresIn = this.configService.get<string>('JWT_EXPIRES_IN', '15m');
    const expiresInSeconds = this.parseExpiresIn(expiresIn);

    // Determine redirect URL based on role
    const redirectUrl = this.getRedirectUrl(user, modules);

    return {
      accessToken,
      refreshToken: refreshTokenValue,
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
    if (!match || !match[1] || !match[2]) return 900; // Default 15 minutes

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
        return 900;
    }
  }
}
