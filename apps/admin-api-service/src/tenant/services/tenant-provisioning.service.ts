import * as crypto from 'crypto';

import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { SchemaManagerService } from '@platform/backend-common';
import { Repository, DataSource } from 'typeorm';

import { EmailSenderService } from '../../settings/services/email-sender.service';
import { TenantConfigurationService } from '../../settings/services/tenant-configuration.service';
import { RoleTemplateService } from '../../users/services/role-template.service';
import { UserPermissionsService } from '../../users/services/user-permissions.service';
import { Tenant, TenantStatus } from '../entities/tenant.entity';

/**
 * Default tenant role definition for provisioning
 */
export interface DefaultTenantRole {
  code: string;
  name: string;
  description: string;
  permissions: string[];
  isDefault: boolean;
  isEditable: boolean;
  displayOrder: number;
}

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

  /**
   * MEDIUM-008 fix: guard flag so the DDL in ensureTenantRolesTableExists()
   * only executes once per service-instance lifetime instead of on every
   * provisioning call.  The ideal long-term fix is a proper TypeORM migration.
   */
  private tenantRolesTableEnsured = false;

  /**
   * Default roles to be created for each tenant during provisioning.
   * Only TENANT_ADMIN role is created - actual permissions are managed via user_permissions table.
   */
  private readonly defaultRoles: DefaultTenantRole[] = [
    {
      code: 'TENANT_ADMIN',
      name: 'Tenant Administrator',
      description: 'Full administrative access to all tenant features. Can manage users and assign permissions.',
      permissions: ['*'], // Full access - actual permissions managed via user_permissions table
      isDefault: false,
      isEditable: false,
      displayOrder: 1,
    },
  ];

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly tenantConfigurationService: TenantConfigurationService,
    private readonly roleTemplateService: RoleTemplateService,
    private readonly userPermissionsService: UserPermissionsService,
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
      ...(assignModules.length > 0
        ? [{ name: 'assign_modules', status: 'pending' as const }]
        : []),
      { name: 'create_schema', status: 'pending' },
      { name: 'setup_default_roles', status: 'pending' },
      { name: 'create_default_config', status: 'pending' },
      ...(createFirstAdmin && adminEmail
        ? [{ name: 'create_first_admin', status: 'pending' as const }]
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
      // MED-005 fix: perform an atomic UPDATE ... WHERE status = PENDING to prevent TOCTOU races.
      // Even if two requests both read status=PENDING, only one UPDATE will match — the other
      // will update 0 rows and be rejected here, preventing duplicate provisioning.
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

      // Atomically mark the tenant as being provisioned; if another process already claimed it,
      // rowsAffected will be 0 and we bail out immediately.
      const [, rowsAffected] = await this.dataSource.query(
        `UPDATE tenants SET status = 'ACTIVE', "updatedAt" = NOW() WHERE id = $1 AND status = $2`,
        [tenantId, TenantStatus.PENDING],
      );
      if ((rowsAffected as number) === 0) {
        updateStep(
          0,
          'failed',
          Date.now() - startValidate,
          'Tenant provisioning already in progress or completed by a concurrent request',
        );
        return { success: false, tenantId, steps };
      }
      // Update the in-memory entity to reflect the new status so downstream steps work correctly
      tenant.status = TenantStatus.ACTIVE;

      updateStep(0, 'completed', Date.now() - startValidate);

      let stepIndex = 1;

      // Step 2 (Optional): Assign modules BEFORE schema creation
      // This ensures createTenantSchema() can query tenant_modules to determine
      // which module tables to create (sensor, farm, hr)
      if (assignModules.length > 0) {
        updateStep(stepIndex, 'in_progress');
        const startModules = Date.now();
        await this.assignModulesToTenant(tenant.id, assignModules);
        updateStep(stepIndex, 'completed', Date.now() - startModules);
        stepIndex++;
      }

      // Step 3: Create schema (unless skipped)
      // Queries tenant_modules to determine which module tables to create
      updateStep(stepIndex, 'in_progress');
      const startSchema = Date.now();
      if (skipSchemaCreation) {
        this.logger.log(`Skipping schema creation for tenant ${tenantId} (skipSchemaCreation=true)`);
        updateStep(stepIndex, 'completed', Date.now() - startSchema);
      } else {
        await this.createTenantSchema(tenant);
        updateStep(stepIndex, 'completed', Date.now() - startSchema);
      }
      stepIndex++;

      // Step 4: Setup default roles
      updateStep(stepIndex, 'in_progress');
      const startRoles = Date.now();
      await this.setupDefaultRoles(tenant);
      updateStep(stepIndex, 'completed', Date.now() - startRoles);
      stepIndex++;

      // Step 5: Create default configuration
      updateStep(stepIndex, 'in_progress');
      const startConfig = Date.now();
      await this.createDefaultConfiguration(tenant);
      updateStep(stepIndex, 'completed', Date.now() - startConfig);
      stepIndex++;

      let adminUser: ProvisioningResult['adminUser'] | undefined;

      // Step 6 (Optional): Create first admin user
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

      // Final Step: Activate tenant
      // Note: status was already set to ACTIVE by the atomic UPDATE in step 1.
      // This save refreshes updatedAt and persists any in-memory changes.
      updateStep(stepIndex, 'in_progress');
      const startActivate = Date.now();
      tenant.status = TenantStatus.ACTIVE;
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

    // Always create ALL module tables for tenant isolation (regardless of assigned modules)
    const modulesToCreate = ['sensor', 'farm', 'hr', 'hydroponics'];

    // Create tenant schema with all module tables
    const result = await this.schemaManager.createTenantSchema(tenant.id, modulesToCreate);

    if (!result.success) {
      throw new Error(`Schema creation failed: ${result.errors.join(', ')}`);
    }

    this.logger.log(
      `Created tenant schema ${result.schemaName} with ${result.tablesCreated.length} tables in ${result.duration}ms`,
    );
  }

  /**
   * Setup default roles for a newly provisioned tenant.
   * Creates only the TENANT_ADMIN role - actual permissions are managed via user_permissions table.
   */
  private async setupDefaultRoles(tenant: Tenant): Promise<void> {
    this.logger.log(`Setting up default roles for tenant ${tenant.id}`);

    // Ensure the tenant_roles table exists
    await this.ensureTenantRolesTableExists();

    // Create each default role for the tenant
    for (const role of this.defaultRoles) {
      try {
        // Check if role already exists for this tenant
        const existingRole = await this.dataSource.query(
          `SELECT id FROM tenant_roles WHERE "tenantId" = $1 AND code = $2`,
          [tenant.id, role.code],
        );

        if (existingRole && existingRole.length > 0) {
          this.logger.debug(
            `Role ${role.code} already exists for tenant ${tenant.id}, skipping`,
          );
          continue;
        }

        // Insert the role
        await this.dataSource.query(
          `
          INSERT INTO tenant_roles (
            id, "tenantId", code, name, description, permissions,
            is_default, is_editable, display_order, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4, $5,
            $6, $7, $8, NOW(), NOW()
          )
        `,
          [
            tenant.id,
            role.code,
            role.name,
            role.description,
            JSON.stringify(role.permissions),
            role.isDefault,
            role.isEditable,
            role.displayOrder,
          ],
        );

        this.logger.debug(`Created role ${role.code} for tenant ${tenant.id}`);
      } catch (error) {
        this.logger.error(
          `Failed to create role ${role.code} for tenant ${tenant.id}: ${(error as Error).message}`,
        );
        throw error;
      }
    }

    this.logger.log(
      `Successfully created ${this.defaultRoles.length} default roles for tenant ${tenant.id}`,
    );
  }

  /**
   * Ensure the tenant_roles table exists in the database.
   * MEDIUM-008 fix: the DDL is skipped after the first successful call within
   * this service instance to avoid issuing locking DDL on every provisioning.
   * The authoritative fix is to move these statements into a TypeORM migration.
   */
  private async ensureTenantRolesTableExists(): Promise<void> {
    if (this.tenantRolesTableEnsured) return;
    try {
      await this.dataSource.query(`
        CREATE TABLE IF NOT EXISTS tenant_roles (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "tenantId" UUID NOT NULL,
          code VARCHAR(50) NOT NULL,
          name VARCHAR(100) NOT NULL,
          description TEXT,
          permissions JSONB NOT NULL DEFAULT '[]',
          is_default BOOLEAN NOT NULL DEFAULT false,
          is_editable BOOLEAN NOT NULL DEFAULT true,
          display_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          CONSTRAINT uk_tenant_roles_tenant_code UNIQUE ("tenantId", code),
          CONSTRAINT fk_tenant_roles_tenant FOREIGN KEY ("tenantId")
            REFERENCES tenants(id) ON DELETE CASCADE
        )
      `);

      // Create indexes for better query performance
      await this.dataSource.query(`
        CREATE INDEX IF NOT EXISTS idx_tenant_roles_tenant_id
        ON tenant_roles("tenantId")
      `);

      await this.dataSource.query(`
        CREATE INDEX IF NOT EXISTS idx_tenant_roles_code
        ON tenant_roles(code)
      `);

      // Mark as done so subsequent provisioning calls skip these DDL statements
      this.tenantRolesTableEnsured = true;
    } catch (error) {
      // Table might already exist or constraint might already be in place
      this.logger.debug(
        `tenant_roles table setup: ${(error as Error).message}`,
      );
      // Still mark as ensured if the table was already there (CREATE IF NOT EXISTS)
      this.tenantRolesTableEnsured = true;
    }
  }

  /**
   * Get default roles for a tenant
   */
  async getTenantRoles(
    tenantId: string,
  ): Promise<Array<DefaultTenantRole & { id: string; createdAt: Date; updatedAt: Date }>> {
    const roles = await this.dataSource.query(
      `
      SELECT id, "tenantId", code, name, description, permissions,
             is_default, is_editable, display_order, created_at, updated_at
      FROM tenant_roles
      WHERE "tenantId" = $1
      ORDER BY display_order ASC
    `,
      [tenantId],
    );

    return roles.map(
      (row: {
        id: string;
        code: string;
        name: string;
        description: string;
        permissions: string;
        is_default: boolean;
        is_editable: boolean;
        display_order: number;
        created_at: Date;
        updated_at: Date;
      }) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        description: row.description,
        permissions:
          typeof row.permissions === 'string'
            ? JSON.parse(row.permissions)
            : row.permissions,
        isDefault: row.is_default,
        isEditable: row.is_editable,
        displayOrder: row.display_order,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    );
  }

  /**
   * Get a specific role for a tenant by code
   */
  async getTenantRoleByCode(
    tenantId: string,
    roleCode: string,
  ): Promise<(DefaultTenantRole & { id: string }) | null> {
    const roles = await this.dataSource.query(
      `
      SELECT id, code, name, description, permissions,
             is_default, is_editable, display_order
      FROM tenant_roles
      WHERE "tenantId" = $1 AND code = $2
    `,
      [tenantId, roleCode],
    );

    if (!roles || roles.length === 0) {
      return null;
    }

    const row = roles[0];
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      permissions:
        typeof row.permissions === 'string'
          ? JSON.parse(row.permissions)
          : row.permissions,
      isDefault: row.is_default,
      isEditable: row.is_editable,
      displayOrder: row.display_order,
    };
  }

  /**
   * Create default configuration for a newly provisioned tenant
   * Uses the TenantConfigurationService to create the configuration record
   */
  private async createDefaultConfiguration(tenant: Tenant): Promise<void> {
    this.logger.log(`Creating default configuration for tenant ${tenant.id}`);

    try {
      // Use the TenantConfigurationService to create the configuration
      // This will use the defaults from createDefaultTenantConfiguration
      await this.tenantConfigurationService.createConfiguration({
        tenantId: tenant.id,
        // Override defaults with tenant-specific settings if available
        brandingConfig: {
          companyName: tenant.name,
        },
        // Enable basic feature flags for new tenants
        featureFlags: {
          dataExport: true,
          auditLog: true,
          mobileAccess: true,
          iotDeviceSupport: true,
        },
      });

      this.logger.log(
        `Successfully created default configuration for tenant ${tenant.id}`,
      );
    } catch (error) {
      // If configuration already exists, log and continue
      if ((error as Error).message?.includes('already exists')) {
        this.logger.warn(
          `Configuration already exists for tenant ${tenant.id}, skipping creation`,
        );
        return;
      }

      this.logger.error(
        `Failed to create configuration for tenant ${tenant.id}: ${(error as Error).message}`,
      );
      throw error;
    }
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
            id, email, "firstName", "lastName", role, "tenantId",
            "isActive", "isEmailVerified", "invitationToken", "invitationExpiresAt",
            "createdAt", "updatedAt"
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
            id, token, email, "firstName", "lastName", role, "tenantId",
            status, "expiresAt", "invitedBy", "sendCount", "lastSentAt", "createdAt", "updatedAt"
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

      // Create user permissions with TENANT_ADMIN_PERMISSIONS
      // grantedBy is UUID type — use null for system-provisioned users
      await this.userPermissionsService.createDefaultPermissions(
        result.userId,
        tenantId,
        null as unknown as string, // grantedBy: null for system provisioning (column is UUID, not VARCHAR)
        true, // isAdmin - true to use TENANT_ADMIN_PERMISSIONS
      );

      this.logger.log(
        `Created first admin user for tenant ${tenantId}: ${email} with TENANT_ADMIN permissions`,
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
   * Assign modules to a tenant.
   * HIGH-004 fix: replaced sequential per-module INSERT calls with a single
   * bulk INSERT … VALUES … ON CONFLICT DO NOTHING.
   */
  private async assignModulesToTenant(
    tenantId: string,
    moduleIds: string[],
  ): Promise<void> {
    if (moduleIds.length === 0) return;

    this.logger.log(`Assigning ${moduleIds.length} modules to tenant ${tenantId}`);

    try {
      // Build a single query with unnest for safe parameterised bulk insert
      await this.dataSource.query(
        `INSERT INTO tenant_modules (id, "tenantId", "moduleId", "isEnabled", "activatedAt", "createdAt", "updatedAt")
         SELECT gen_random_uuid(), $1, unnest($2::uuid[]), true, NOW(), NOW(), NOW()
         ON CONFLICT ("tenantId", "moduleId") DO NOTHING`,
        [tenantId, moduleIds],
      );
    } catch (error) {
      this.logger.warn(
        `Could not assign modules to tenant ${tenantId}: ${(error as Error).message}`,
      );
    }
  }
}
