import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Role } from '@platform/backend-common';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';

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
 */
@Injectable()
export class SeedService implements OnModuleInit {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Module)
    private readonly moduleRepository: Repository<Module>,
  ) {}

  async onModuleInit() {
    await this.seed();
  }

  async seed() {
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
  private async seedModules() {
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
   */
  private async seedSuperAdmin() {
    const superAdminEmail = process.env.SUPER_ADMIN_EMAIL || 'by-okan@live.com';
    const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD || '12345678';

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

    this.logger.log(`Creating SUPER_ADMIN user: ${superAdminEmail}`);

    // Hash password manually (bypassing entity hook for clarity)
    const salt = await bcrypt.genSalt(12);
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
