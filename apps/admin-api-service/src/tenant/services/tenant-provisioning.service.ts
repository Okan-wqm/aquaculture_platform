import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Tenant, TenantStatus } from '../entities/tenant.entity';
import * as crypto from 'crypto';
import { EmailSenderService } from '../../settings/services/email-sender.service';
import { SchemaManagerService } from '@platform/backend-common';

export interface ProvisioningResult {
  success: boolean;
  tenantId: string;
  steps: ProvisioningStep[];
  error?: string;
  adminUser?: {
    userId: string;
    email: string;
    invitationToken: string;
  };
}

export interface ProvisioningStep {
  name: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  duration?: number;
  error?: string;
}

export interface TenantProvisioningOptions {
  createFirstAdmin?: boolean;
  adminEmail?: string;
  adminFirstName?: string;
  adminLastName?: string;
  assignModules?: string[];
  skipSchemaCreation?: boolean;
}

@Injectable()
export class TenantProvisioningService {
  private readonly logger = new Logger(TenantProvisioningService.name);
  private readonly schemaManager: SchemaManagerService;

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Optional()
    private readonly emailSenderService?: EmailSenderService,
  ) {
    // Initialize schema manager with dataSource
    this.schemaManager = new SchemaManagerService(this.dataSource);
  }

  /**
   * Provision a new tenant with all required resources
   */
  async provisionTenant(
    tenantId: string,
    options: TenantProvisioningOptions = {},
  ): Promise<ProvisioningResult> {
    const {
      createFirstAdmin = false,
      adminEmail,
      adminFirstName,
      adminLastName,
      assignModules = [],
      skipSchemaCreation = false,
    } = options;

    const steps: ProvisioningStep[] = [
      { name: 'validate_tenant', status: 'pending' },
      { name: 'create_schema', status: 'pending' },
      { name: 'setup_default_roles', status: 'pending' },
      { name: 'create_default_config', status: 'pending' },
      ...(createFirstAdmin && adminEmail
        ? [{ name: 'create_first_admin', status: 'pending' as const }]
        : []),
      ...(assignModules.length > 0
        ? [{ name: 'assign_modules', status: 'pending' as const }]
        : []),
      { name: 'activate_tenant', status: 'pending' },
    ];

    const updateStep = (
      index: number,
      status: ProvisioningStep['status'],
      duration?: number,
      error?: string,
    ): void => {
      const step = steps[index];
      if (step) {
        step.status = status;
        if (duration !== undefined) step.duration = duration;
        if (error !== undefined) step.error = error;
      }
    };

    try {
      const tenant = await this.tenantRepository.findOne({
        where: { id: tenantId },
      });

      if (!tenant) {
        return {
          success: false,
          tenantId,
          steps,
          error: `Tenant ${tenantId} not found`,
        };
      }

      // Step 1: Validate tenant
      updateStep(0, 'in_progress');
      const startValidate = Date.now();

      if (tenant.status !== TenantStatus.PENDING) {
        updateStep(
          0,
          'failed',
          undefined,
          `Tenant status must be PENDING, got ${tenant.status}`,
        );
        return { success: false, tenantId, steps };
      }

      updateStep(0, 'completed', Date.now() - startValidate);

      // Step 2: Create schema (unless skipped)
      updateStep(1, 'in_progress');
      const startSchema = Date.now();
      if (skipSchemaCreation) {
        this.logger.log(`Skipping schema creation for tenant ${tenantId} (skipSchemaCreation=true)`);
        updateStep(1, 'completed', Date.now() - startSchema);
      } else {
        await this.createTenantSchema(tenant);
        updateStep(1, 'completed', Date.now() - startSchema);
      }

      // Step 3: Setup default roles
      updateStep(2, 'in_progress');
      const startRoles = Date.now();
      await this.setupDefaultRoles(tenant);
      updateStep(2, 'completed', Date.now() - startRoles);

      // Step 4: Create default configuration
      updateStep(3, 'in_progress');
      const startConfig = Date.now();
      await this.createDefaultConfiguration(tenant);
      updateStep(3, 'completed', Date.now() - startConfig);

      let stepIndex = 4;
      let adminUser: ProvisioningResult['adminUser'] | undefined;

      // Step 5 (Optional): Create first admin user
      if (createFirstAdmin && adminEmail) {
        updateStep(stepIndex, 'in_progress');
        const startAdmin = Date.now();
        const adminResult = await this.createFirstAdminUser(
          tenant.id,
          adminEmail,
          adminFirstName || 'Admin',
          adminLastName || 'User',
        );

        if (!adminResult.success) {
          updateStep(stepIndex, 'failed', Date.now() - startAdmin, adminResult.error);
          // Don't fail the whole provisioning, just log warning
          this.logger.warn(
            `Could not create first admin for tenant ${tenantId}: ${adminResult.error}`,
          );
        } else {
          adminUser = {
            userId: adminResult.userId!,
            email: adminEmail,
            invitationToken: adminResult.invitationToken!,
          };
          updateStep(stepIndex, 'completed', Date.now() - startAdmin);

          // Send invitation email
          if (this.emailSenderService) {
            try {
              const expiresAt = new Date();
              expiresAt.setDate(expiresAt.getDate() + 7);

              const emailResult = await this.emailSenderService.sendInvitationEmail({
                email: adminEmail,
                firstName: adminFirstName || 'Admin',
                lastName: adminLastName || 'User',
                tenantName: tenant.name,
                invitationToken: adminResult.invitationToken!,
                role: 'TENANT_ADMIN',
                expiresAt,
              });

              if (emailResult.success) {
                this.logger.log(`Invitation email sent to ${adminEmail}`);
              } else {
                this.logger.warn(`Failed to send invitation email to ${adminEmail}: ${emailResult.error}`);
              }
            } catch (emailError) {
              this.logger.warn(`Error sending invitation email: ${(emailError as Error).message}`);
            }
          } else {
            this.logger.warn('EmailSenderService not available, invitation email not sent');
          }
        }
        stepIndex++;
      }

      // Step 6 (Optional): Assign modules to tenant
      if (assignModules.length > 0) {
        updateStep(stepIndex, 'in_progress');
        const startModules = Date.now();
        await this.assignModulesToTenant(tenant.id, assignModules);
        updateStep(stepIndex, 'completed', Date.now() - startModules);
        stepIndex++;
      }

      // Final Step: Activate tenant
      updateStep(stepIndex, 'in_progress');
      const startActivate = Date.now();
      tenant.status = TenantStatus.ACTIVE;
      tenant.lastActivityAt = new Date();
      await this.tenantRepository.save(tenant);
      updateStep(stepIndex, 'completed', Date.now() - startActivate);

      this.logger.log(`Tenant ${tenantId} provisioned successfully`);

      return {
        success: true,
        tenantId,
        steps,
        adminUser,
      };
    } catch (error) {
      this.logger.error(
        `Failed to provision tenant ${tenantId}: ${(error as Error).message}`,
        (error as Error).stack,
      );

      // Mark current step as failed
      const currentStep = steps.find((s) => s.status === 'in_progress');
      if (currentStep) {
        currentStep.status = 'failed';
        currentStep.error = (error as Error).message;
      }

      return {
        success: false,
        tenantId,
        steps,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Deprovision a tenant and clean up resources
   */
  async deprovisionTenant(tenantId: string): Promise<ProvisioningResult> {
    const steps: ProvisioningStep[] = [
      { name: 'validate_tenant', status: 'pending' },
      { name: 'backup_data', status: 'pending' },
      { name: 'remove_resources', status: 'pending' },
      { name: 'cleanup_schema', status: 'pending' },
    ];

    const updateStep = (
      index: number,
      status: ProvisioningStep['status'],
      error?: string,
    ): void => {
      const step = steps[index];
      if (step) {
        step.status = status;
        if (error !== undefined) step.error = error;
      }
    };

    try {
      const tenant = await this.tenantRepository.findOne({
        where: { id: tenantId },
      });

      if (!tenant) {
        return {
          success: false,
          tenantId,
          steps,
          error: `Tenant ${tenantId} not found`,
        };
      }

      // Validate tenant can be deprovisioned
      updateStep(0, 'in_progress');
      if (tenant.status === TenantStatus.ACTIVE) {
        updateStep(0, 'failed', 'Cannot deprovision an active tenant');
        return { success: false, tenantId, steps };
      }
      updateStep(0, 'completed');

      // Backup data
      updateStep(1, 'in_progress');
      await this.backupTenantData(tenant);
      updateStep(1, 'completed');

      // Remove resources
      updateStep(2, 'in_progress');
      await this.removeTenantResources(tenant);
      updateStep(2, 'completed');

      // Cleanup schema
      updateStep(3, 'in_progress');
      await this.cleanupTenantSchema(tenant);
      updateStep(3, 'completed');

      this.logger.log(`Tenant ${tenantId} deprovisioned successfully`);

      return { success: true, tenantId, steps };
    } catch (error) {
      const currentStep = steps.find((s) => s.status === 'in_progress');
      if (currentStep) {
        currentStep.status = 'failed';
        currentStep.error = (error as Error).message;
      }

      return {
        success: false,
        tenantId,
        steps,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Get provisioning status for a tenant
   */
  async getProvisioningStatus(
    tenantId: string,
  ): Promise<{ status: string; tenant?: Tenant }> {
    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
    });

    if (!tenant) {
      return { status: 'not_found' };
    }

    switch (tenant.status) {
      case TenantStatus.PENDING:
        return { status: 'pending', tenant };
      case TenantStatus.ACTIVE:
        return { status: 'provisioned', tenant };
      case TenantStatus.SUSPENDED:
        return { status: 'suspended', tenant };
      case TenantStatus.DEACTIVATED:
        return { status: 'deactivated', tenant };
      case TenantStatus.ARCHIVED:
        return { status: 'archived', tenant };
      default:
        return { status: 'unknown', tenant };
    }
  }

  private async createTenantSchema(tenant: Tenant): Promise<void> {
    this.logger.log(`Creating schema for tenant ${tenant.id}`);

    // Get assigned modules for this tenant
    const tenantModulesResult = await this.dataSource.query(
      `SELECT m.code FROM tenant_modules tm
       JOIN modules m ON tm.module_id = m.id
       WHERE tm.tenant_id = $1 AND tm.is_active = true`,
      [tenant.id],
    );

    // Map module codes to schema module names
    const moduleCodeMap: Record<string, string> = {
      'farm': 'farm',
      'sensor': 'sensor',
      'hr': 'hr',
    };

    const modules = tenantModulesResult
      .map((r: { code: string }) => moduleCodeMap[r.code])
      .filter(Boolean);

    // If no modules assigned, create all schemas
    const modulesToCreate = modules.length > 0 ? modules : ['sensor', 'farm', 'hr'];

    // Create tenant schema with all module tables
    const result = await this.schemaManager.createTenantSchema(tenant.id, modulesToCreate);

    if (!result.success) {
      throw new Error(`Schema creation failed: ${result.errors.join(', ')}`);
    }

    this.logger.log(
      `Created tenant schema ${result.schemaName} with ${result.tablesCreated.length} tables in ${result.duration}ms`,
    );
  }

  private async setupDefaultRoles(tenant: Tenant): Promise<void> {
    // Setup default roles for the tenant
    this.logger.log(`Setting up default roles for tenant ${tenant.id}`);

    // Default roles: admin, manager, operator, viewer
    // In real implementation, this would create role records
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  private async createDefaultConfiguration(tenant: Tenant): Promise<void> {
    // Create default configuration for the tenant
    this.logger.log(`Creating default configuration for tenant ${tenant.id}`);

    // In real implementation, this would create configuration records
    // using the Config Service
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  private async backupTenantData(tenant: Tenant): Promise<void> {
    this.logger.log(`Backing up data for tenant ${tenant.id}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  private async removeTenantResources(tenant: Tenant): Promise<void> {
    this.logger.log(`Removing resources for tenant ${tenant.id}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  private async cleanupTenantSchema(tenant: Tenant): Promise<void> {
    this.logger.log(`Cleaning up schema for tenant ${tenant.id}`);

    const result = await this.schemaManager.deleteTenantSchema(tenant.id);
    if (!result.success) {
      throw new Error(`Schema cleanup failed: ${result.error}`);
    }

    this.logger.log(`Tenant schema deleted for ${tenant.id}`);
  }

  /**
   * Create first admin user for a tenant
   */
  private async createFirstAdminUser(
    tenantId: string,
    email: string,
    firstName: string,
    lastName: string,
  ): Promise<{
    success: boolean;
    userId?: string;
    invitationToken?: string;
    error?: string;
  }> {
    try {
      // Check if email already exists
      const existingUser = await this.dataSource.query(
        `SELECT id FROM users WHERE LOWER(email) = LOWER($1)`,
        [email],
      );

      if (existingUser && existingUser.length > 0) {
        return {
          success: false,
          error: 'A user with this email already exists',
        };
      }

      // Generate invitation token
      const invitationToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

      // Create user in transaction
      const result = await this.dataSource.transaction(async (manager) => {
        // Create user with invitation token
        const userResult = await manager.query(
          `
          INSERT INTO users (
            id, email, first_name, last_name, role, tenant_id,
            is_active, is_email_verified, invitation_token, invitation_expires_at,
            created_at, updated_at
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, 'TENANT_ADMIN', $4,
            true, false, $5, $6,
            NOW(), NOW()
          )
          RETURNING id
        `,
          [email, firstName, lastName, tenantId, invitationToken, expiresAt],
        );

        const userId = userResult[0].id;

        // Create invitation record
        await manager.query(
          `
          INSERT INTO invitations (
            id, token, email, first_name, last_name, role, tenant_id,
            status, expires_at, invited_by, send_count, last_sent_at, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4, 'TENANT_ADMIN', $5,
            'PENDING', $6, 'system', 1, NOW(), NOW(), NOW()
          )
        `,
          [invitationToken, email, firstName, lastName, tenantId, expiresAt],
        );

        // Update tenant user count
        await manager.query(
          `UPDATE tenants SET user_count = 1 WHERE id = $1`,
          [tenantId],
        );

        return { userId };
      });

      this.logger.log(
        `Created first admin user for tenant ${tenantId}: ${email}`,
      );

      return {
        success: true,
        userId: result.userId,
        invitationToken,
      };
    } catch (error) {
      this.logger.error(
        `Failed to create first admin: ${(error as Error).message}`,
      );
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Assign modules to a tenant
   */
  private async assignModulesToTenant(
    tenantId: string,
    moduleIds: string[],
  ): Promise<void> {
    this.logger.log(`Assigning ${moduleIds.length} modules to tenant ${tenantId}`);

    for (const moduleId of moduleIds) {
      try {
        await this.dataSource.query(
          `
          INSERT INTO tenant_modules (
            id, tenant_id, module_id, is_active, assigned_at, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), $1, $2, true, NOW(), NOW(), NOW()
          )
          ON CONFLICT (tenant_id, module_id) DO NOTHING
        `,
          [tenantId, moduleId],
        );
      } catch (error) {
        this.logger.warn(
          `Could not assign module ${moduleId} to tenant ${tenantId}: ${(error as Error).message}`,
        );
      }
    }
  }
}
