import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Role } from '@platform/backend-common';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';

import { SECURITY_CONSTANTS } from '../constants/auth.constants';
import { User } from '../modules/authentication/entities/user.entity';
import { Module } from '../modules/system-module/entities/module.entity';


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
   * @throws Error if email is not set in production
   * @throws Error if email format is invalid
   * @returns Validated email address
   */
  private getSuperAdminEmail(): string {
    const emailFromEnv = process.env.SUPER_ADMIN_EMAIL;
    const defaultDevEmail = 'admin@localhost.dev';

    // In production, SUPER_ADMIN_EMAIL is required
    if (!this.isDevelopment()) {
      if (!emailFromEnv || emailFromEnv.trim() === '') {
        this.logger.error(
          'SUPER_ADMIN_EMAIL environment variable is required in production. ' +
            'Please set SUPER_ADMIN_EMAIL to a valid email address for the super admin account.',
        );
        throw new Error(
          'SUPER_ADMIN_EMAIL environment variable is required in production. ' +
            'Set this to a valid email address for the super admin account. ' +
            'Example: export SUPER_ADMIN_EMAIL="admin@yourcompany.com"',
        );
      }
    }

    // Use environment variable or default (development only)
    const email = emailFromEnv?.trim() || (this.isDevelopment() ? defaultDevEmail : '');

    if (!email) {
      throw new Error('SUPER_ADMIN_EMAIL is required but not set.');
    }

    // Validate email format
    if (!this.isValidEmail(email)) {
      this.logger.error(`Invalid email format for SUPER_ADMIN_EMAIL: ${email}`);
      throw new Error(
        `Invalid email format for SUPER_ADMIN_EMAIL: "${email}". ` +
          'Please provide a valid email address (e.g., admin@yourcompany.com).',
      );
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
      this.logger.error('Database seed failed:', error);
      throw error;
    }
  }

  /**
   * Seed default system modules
   */
  private async seedModules(): Promise<void> {
    const existingModules = await this.moduleRepository.count();

    if (existingModules > 0) {
      this.logger.log(`Modules already exist (${existingModules} found), skipping module seed`);
      return;
    }

    this.logger.log('Seeding default modules...');

    const defaultModules = Module.createDefaults();

    for (const moduleData of defaultModules) {
      const module = this.moduleRepository.create(moduleData);
      await this.moduleRepository.save(module);
      this.logger.log(`Created module: ${module.code} - ${module.name}`);
    }

    this.logger.log(`Seeded ${defaultModules.length} modules`);
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

    // Check if password is set and not empty
    if (!superAdminPassword || superAdminPassword.trim() === '') {
      this.logger.error(
        'SUPER_ADMIN_PASSWORD environment variable is required to create super admin. ' +
          'Set a strong password (min 12 chars with uppercase, lowercase, numbers, and special characters).',
      );
      throw new Error(
        'SUPER_ADMIN_PASSWORD environment variable must be set and cannot be empty. ' +
          'Please set a strong password for the super admin account.',
      );
    }

    // In production, both must be explicitly set together
    if (!this.isDevelopment()) {
      if (!emailFromEnv && superAdminPassword) {
        throw new Error(
          'In production, both SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set together. ' +
            'SUPER_ADMIN_PASSWORD is set but SUPER_ADMIN_EMAIL is missing.',
        );
      }
      if (emailFromEnv && !superAdminPassword) {
        throw new Error(
          'In production, both SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set together. ' +
            'SUPER_ADMIN_EMAIL is set but SUPER_ADMIN_PASSWORD is missing.',
        );
      }
    }

    // Validate password strength
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])[A-Za-z\d@$!%*?&#]{12,}$/;
    if (!passwordRegex.test(superAdminPassword)) {
      throw new Error(
        'SUPER_ADMIN_PASSWORD must be at least 12 characters with uppercase, lowercase, number, and special character',
      );
    }

    this.logger.log(`Creating SUPER_ADMIN user: ${superAdminEmail}`);

    // Hash password manually (bypassing entity hook for clarity)
    const salt = await bcrypt.genSalt(SECURITY_CONSTANTS.BCRYPT_SALT_ROUNDS);
    const hashedPassword = await bcrypt.hash(superAdminPassword, salt);

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

    await this.userRepository.save(superAdmin);
    this.logger.log(`SUPER_ADMIN created successfully: ${superAdminEmail}`);
  }
}
