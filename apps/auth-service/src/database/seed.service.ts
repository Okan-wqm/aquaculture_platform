import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Role } from '@aquaculture/backend-common/decorators';
import { STANDING_PLATFORM_CAPABILITIES } from '@platform/event-contracts';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';

import { SECURITY_CONSTANTS } from '../constants/auth.constants';
import { User } from '../modules/authentication/entities/user.entity';
import { Module } from '../modules/system-module/entities/module.entity';
import { PlatformCapabilityGrant } from '../modules/tenant/entities/platform-capability-grant.entity';


/**
 * Database Seed Service
 *
 * Handles initial database seeding:
 * - Creates SUPER_ADMIN user if not exists
 * - Creates default modules if not exist
 *
 * Runs automatically on application startup.
 *
 * Required Environment Variables (for super admin creation):
 * - SUPER_ADMIN_EMAIL: Valid email address for the super admin account
 * - SUPER_ADMIN_PASSWORD: Strong password (min 12 chars with mixed case, numbers, special chars)
 *
 * Note: In development (NODE_ENV=development), a default email is used if not provided.
 * In production, SUPER_ADMIN_EMAIL is required.
 */
@Injectable()
export class SeedService implements OnModuleInit {
  private readonly logger = new Logger(SeedService.name);

  /**
   * Validates email format using RFC 5322 compliant regex
   */
  private isValidEmail(email: string): boolean {
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    return emailRegex.test(email);
  }

  /**
   * Check if running in development environment
   */
  private isDevelopment(): boolean {
    return process.env.NODE_ENV === 'development';
  }

  /**
   * Get and validate super admin email from environment
   *
   * Returns null if email is not configured — caller must handle gracefully.
   * ARCHITECTURAL DECISION: Seed failures must never crash the service.
   * A missing env var is a configuration gap, not a fatal error.
   *
   * @returns Validated email address, or null if not configured
   */
  private getSuperAdminEmail(): string | null {
    const emailFromEnv = process.env.SUPER_ADMIN_EMAIL;
    const defaultDevEmail = 'admin@localhost.dev';

    // In production, SUPER_ADMIN_EMAIL is required — but missing it is not fatal
    if (!this.isDevelopment()) {
      if (!emailFromEnv || emailFromEnv.trim() === '') {
        this.logger.warn(
          'SUPER_ADMIN_EMAIL not set — skipping super admin seed. ' +
            'Set SUPER_ADMIN_EMAIL to create the initial admin account.',
        );
        return null;
      }
    }

    // Use environment variable or default (development only)
    const email = emailFromEnv?.trim() || (this.isDevelopment() ? defaultDevEmail : '');

    if (!email) {
      this.logger.warn('SUPER_ADMIN_EMAIL not configured — skipping super admin seed.');
      return null;
    }

    // Validate email format
    if (!this.isValidEmail(email)) {
      this.logger.warn(`Invalid email format for SUPER_ADMIN_EMAIL: ${email} — skipping seed.`);
      return null;
    }

    // Log warning if using default email in development
    if (this.isDevelopment() && !emailFromEnv) {
      this.logger.warn(
        `Using default development email: ${defaultDevEmail}. ` +
          'Set SUPER_ADMIN_EMAIL environment variable for custom email.',
      );
    }

    return email;
  }

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Module)
    private readonly moduleRepository: Repository<Module>,
    @InjectRepository(PlatformCapabilityGrant)
    private readonly capabilityGrantRepository: Repository<PlatformCapabilityGrant>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seed();
  }

  async seed(): Promise<void> {
    this.logger.log('Starting database seed...');

    try {
      await this.seedModules();
      await this.seedSuperAdmin();
      this.logger.log('Database seed completed successfully');
    } catch (error) {
      // IMPORTANT: Seed failure must NOT crash the service.
      // The service must start and serve requests regardless of seed outcome.
      // Admins can fix config and restart to retry seeding.
      this.logger.error(
        `Database seed failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Seed default system modules
   */
  private async seedModules(): Promise<void> {
    const defaultModules = Module.createDefaults();
    let created = 0;

    for (const moduleData of defaultModules) {
      const existing = await this.moduleRepository.findOne({
        where: { code: moduleData.code },
      });

      if (existing) {
        this.logger.log(`Module already exists: ${moduleData.code}, skipping`);
        continue;
      }

      const module = this.moduleRepository.create(moduleData);
      await this.moduleRepository.save(module);
      this.logger.log(`Created module: ${module.code} - ${module.name}`);
      created++;
    }

    if (created > 0) {
      this.logger.log(`Seeded ${created} new modules`);
    } else {
      this.logger.log('All modules already exist, nothing to seed');
    }
  }

  /**
   * Seed SUPER_ADMIN user
   *
   * Environment variable requirements:
   * - Production: SUPER_ADMIN_EMAIL is required (no default)
   * - Development: Falls back to 'admin@localhost.dev' if not set
   * - SUPER_ADMIN_PASSWORD is always required when creating a new super admin
   * - Both email and password must be provided together
   */
  private async seedSuperAdmin(): Promise<void> {
    const superAdminEmail = this.getSuperAdminEmail();

    // LIFE-SAFETY: Service must start regardless of seed outcome.
    // A missing env var is a config gap, not a reason to crash.
    if (!superAdminEmail) {
      return;
    }

    // Check if SUPER_ADMIN already exists
    const existingSuperAdmin = await this.userRepository.findOne({
      where: { email: superAdminEmail },
    });

    if (existingSuperAdmin) {
      this.logger.log(`SUPER_ADMIN already exists: ${superAdminEmail}`);

      // Ensure role is correct
      if (existingSuperAdmin.role !== Role.SUPER_ADMIN) {
        existingSuperAdmin.role = Role.SUPER_ADMIN;
        existingSuperAdmin.tenantId = null;
        await this.userRepository.save(existingSuperAdmin);
        this.logger.log('Updated existing user to SUPER_ADMIN role');
      }

      return;
    }

    // Validate that both email and password are set together for new super admin creation
    const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD;
    const emailFromEnv = process.env.SUPER_ADMIN_EMAIL;

    // Check if password is set and not empty — skip seed if missing
    if (!superAdminPassword || superAdminPassword.trim() === '') {
      this.logger.warn(
        'SUPER_ADMIN_PASSWORD not set — skipping super admin creation. ' +
          'Set SUPER_ADMIN_PASSWORD to create the initial admin account.',
      );
      return;
    }

    // In production, both must be explicitly set together — skip if inconsistent
    if (!this.isDevelopment()) {
      if (!emailFromEnv && superAdminPassword) {
        this.logger.warn(
          'SUPER_ADMIN_PASSWORD is set but SUPER_ADMIN_EMAIL is missing — skipping seed.',
        );
        return;
      }
    }

    // Validate password strength — skip if weak (don't crash)
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])[A-Za-z\d@$!%*?&#]{12,}$/;
    if (!passwordRegex.test(superAdminPassword)) {
      this.logger.warn(
        'SUPER_ADMIN_PASSWORD does not meet strength requirements (min 12 chars, mixed case, number, special char). ' +
          'Skipping super admin creation. Fix password and restart to seed.',
      );
      return;
    }

    this.logger.log(`Creating SUPER_ADMIN user: ${superAdminEmail}`);

    // SECURITY (HIGH-006): use platform hashPassword (HMAC-peppered bcrypt).
    // In production PASSWORD_PEPPER is required so the seeded super-admin hash
    // includes the p1: prefix; in dev without a pepper the hash falls back to
    // plain bcrypt (matching the previous seed behaviour).
    const { hashPassword } = await import('@aquaculture/backend-common');
    const hashedPassword = await hashPassword(superAdminPassword);

    const superAdmin = this.userRepository.create({
      email: superAdminEmail,
      password: hashedPassword,
      firstName: 'Super',
      lastName: 'Admin',
      role: Role.SUPER_ADMIN,
      tenantId: null, // SUPER_ADMIN has no tenant
      isActive: true,
      isEmailVerified: true,
      invitationToken: null, // No invitation needed
    });

    const saved = await this.userRepository.save(superAdmin);
    await this.seedStandingCapabilities(saved);
    this.logger.log(`SUPER_ADMIN created successfully: ${superAdminEmail}`);
  }

  /**
   * ADR-0016: a SUPER_ADMIN with no capability grant is read-only on the
   * platform-admin surface, and the capability that grants capabilities
   * (`security-ops`) can only come from a holder. The first account therefore
   * receives the three standing capabilities here, granted by itself with a
   * reason naming this seed — exactly what the bootstrap migration does for
   * accounts that pre-date the grant table. `break-glass` is never seeded.
   */
  private async seedStandingCapabilities(superAdmin: User): Promise<void> {
    for (const capability of STANDING_PLATFORM_CAPABILITIES) {
      await this.capabilityGrantRepository.save(
        this.capabilityGrantRepository.create({
          userId: superAdmin.id,
          capability,
          grantedBy: superAdmin.id,
          expiresAt: null,
          revokedBy: null,
          revokedAt: null,
          reason: 'ADR-0016 bootstrap (SeedService): first SUPER_ADMIN receives the standing capabilities',
        }),
      );
    }
  }
}
