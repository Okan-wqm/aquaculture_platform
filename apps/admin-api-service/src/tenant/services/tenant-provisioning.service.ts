import * as crypto from 'crypto';

import { Injectable, Logger, NotImplementedException, Optional } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { SchemaManagerService, DEFAULT_TENANT_MODULES } from '@aquaculture/backend-common/database';
import { LegalHoldService } from '@aquaculture/backend-common/compliance';
import { Repository, DataSource } from 'typeorm';

import {
  TenantSchema,
  SchemaStatus,
} from '../../database-management/entities/database-management.entity';
import { EmailSenderService } from '../../settings/services/email-sender.service';
import { TenantConfigurationService } from '../../settings/services/tenant-configuration.service';
import { RoleTemplateService } from '../../users/services/role-template.service';
import { UserPermissionsService } from '../../users/services/user-permissions.service';
import { Tenant, TenantStatus } from '../entities/tenant.entity';
import { ProvisioningSagaService, SagaResult } from './provisioning-saga.service';

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
  compensationErrors?: Array<{ step: string; error: string }>;
  adminUser?: {
    userId: string;
    email: string;
    // NOTE: invitationToken intentionally omitted from result.
    // The raw token must only travel via email to prevent leakage
    // through API responses, logs, or event payloads.
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
    @InjectRepository(TenantSchema)
    private readonly tenantSchemaRepository: Repository<TenantSchema>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly tenantConfigurationService: TenantConfigurationService,
    private readonly roleTemplateService: RoleTemplateService,
    private readonly userPermissionsService: UserPermissionsService,
    @Optional()
    private readonly emailSenderService?: EmailSenderService,
    // LEGAL-HIGH-006 cure: tenant deprovisioning issues DROP SCHEMA on
    // the tenant's per-tenant schema — irreversible at the DB level.
    // The canonical LegalHoldService is consulted as the FIRST step of
    // deprovisionTenant so a tenant under litigation hold cannot have
    // evidence destroyed. @Optional preserves local-dev paths where
    // the LegalHoldModule may not be wired.
    @Optional()
    private readonly legalHoldService?: LegalHoldService,
  ) {
    // Initialize schema manager with dataSource
    this.schemaManager = new SchemaManagerService(this.dataSource);
  }

  /**
   * Provision a new tenant with all required resources.
   *
   * Uses ProvisioningSagaService to orchestrate steps with compensating
   * transactions. On failure, completed steps are rolled back in reverse.
   *
   * TODO(NATS-MIGRATION): The following steps currently write directly to
   * auth.* tables. They should be replaced with NATS request-reply commands
   * using the contracts in @platform/event-contracts/tenant-commands:
   *   - setupDefaultRoles → SetupTenantRolesCommand
   *   - createFirstAdminUser → CreateTenantAdminCommand
   *   - assignModulesToTenant → AssignTenantModulesCommand
   *   - On rollback → RollbackTenantProvisioningCommand
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

    // Pre-flight: validate tenant exists and is in PENDING state
    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
    });

    if (!tenant) {
      return {
        success: false,
        tenantId,
        steps: [{ name: 'validate_tenant', status: 'failed', error: `Tenant ${tenantId} not found` }],
        error: `Tenant ${tenantId} not found`,
      };
    }

    if (tenant.status !== TenantStatus.PENDING) {
      return {
        success: false,
        tenantId,
        steps: [{
          name: 'validate_tenant',
          status: 'failed',
          error: `Tenant status must be PENDING, got ${tenant.status}`,
        }],
        error: `Tenant status must be PENDING, got ${tenant.status}`,
      };
    }

    // SECURITY: Atomically claim the tenant for provisioning by setting status
    // to PROVISIONING to prevent TOCTOU races. The tenant stays in a non-ACTIVE
    // state until the full provisioning saga completes successfully.
    // Previously, the tenant was set to ACTIVE here, before schema creation,
    // role setup, and admin creation, allowing partially provisioned tenants
    // to become visible as active.
    const [, rowsAffected] = await this.dataSource.query(
      `UPDATE auth.tenants SET status = 'PROVISIONING', "updatedAt" = NOW() WHERE id = $1 AND status = $2`,
      [tenantId, TenantStatus.PENDING],
    );
    if ((rowsAffected as number) === 0) {
      return {
        success: false,
        tenantId,
        steps: [{
          name: 'validate_tenant',
          status: 'failed',
          error: 'Tenant provisioning already in progress or completed by a concurrent request',
        }],
        error: 'Tenant provisioning already in progress or completed by a concurrent request',
      };
    }
    // Keep as PENDING internally — will be set to ACTIVE only after full saga success
    tenant.status = TenantStatus.PENDING;

    // Build the saga with steps + compensating actions
    const saga = new ProvisioningSagaService();
    let adminUser: ProvisioningResult['adminUser'] | undefined;

    // Step: Assign modules (optional, before schema creation)
    // TODO(NATS-MIGRATION): Replace with NATS AssignTenantModulesCommand
    if (assignModules.length > 0) {
      saga.addStep(
        'assign_modules',
        async () => {
          await this.assignModulesToTenant(tenant.id, assignModules);
        },
        async () => {
          // Compensate: remove assigned modules
          this.logger.warn(`Compensating: removing modules for tenant ${tenant.id}`);
          await this.dataSource.query(
            `DELETE FROM auth.tenant_modules WHERE "tenantId" = $1`,
            [tenant.id],
          ).catch((err: Error) => {
            this.logger.error(`Failed to remove modules during compensation: ${err.message}`);
          });
        },
      );
    }

    // Step: Create tenant schema
    if (!skipSchemaCreation) {
      saga.addStep(
        'create_schema',
        async () => {
          await this.createTenantSchema(tenant);
        },
        async () => {
          // Compensate: delete the schema
          this.logger.warn(`Compensating: deleting schema for tenant ${tenant.id}`);
          await this.schemaManager.deleteTenantSchema(tenant.id);
          // Also clean up tracking record
          const schemaRecord = await this.tenantSchemaRepository.findOne({ where: { tenantId: tenant.id } });
          if (schemaRecord) {
            schemaRecord.status = 'deleted' as SchemaStatus;
            await this.tenantSchemaRepository.save(schemaRecord);
          }
        },
      );
    } else {
      saga.addStep(
        'create_schema',
        async () => {
          this.logger.log(`Skipping schema creation for tenant ${tenantId} (skipSchemaCreation=true)`);
        },
      );
    }

    // Step: Setup default roles
    // TODO(NATS-MIGRATION): Replace with NATS SetupTenantRolesCommand
    saga.addStep(
      'setup_default_roles',
      async () => {
        await this.setupDefaultRoles(tenant);
      },
      async () => {
        // Compensate: delete roles created for this tenant
        this.logger.warn(`Compensating: deleting roles for tenant ${tenant.id}`);
        await this.dataSource.query(
          `DELETE FROM auth.tenant_roles WHERE "tenantId" = $1`,
          [tenant.id],
        ).catch((err: Error) => {
          this.logger.error(`Failed to delete roles during compensation: ${err.message}`);
        });
      },
    );

    // Step: Create default configuration
    saga.addStep(
      'create_default_config',
      async () => {
        await this.createDefaultConfiguration(tenant);
      },
      async () => {
        // Compensate: configuration cleanup is handled by TenantConfigurationService
        this.logger.warn(`Compensating: removing configuration for tenant ${tenant.id}`);
        // Best effort — config may not have been created
      },
    );

    // Step: Seed default water quality parameter configs
    if (!skipSchemaCreation) {
      saga.addStep(
        'seed_water_quality_params',
        async () => {
          await this.seedDefaultWaterQualityParams(tenant.id);
        },
        async () => {
          // Compensate: best effort cleanup
          this.logger.warn(`Compensating: removing water quality params for tenant ${tenant.id}`);
          const schemaName = `tenant_${tenant.id.replace(/-/g, '_')}`;
          await this.dataSource.query(
            `DELETE FROM "${schemaName}".water_quality_parameter_configs WHERE "tenantId" = $1`,
            [tenant.id],
          ).catch((err: Error) => {
            this.logger.error(`Failed to remove water quality params: ${err.message}`);
          });
        },
      );
    }

    // Step (Optional): Create first admin user
    // TODO(NATS-MIGRATION): Replace with NATS CreateTenantAdminCommand
    if (createFirstAdmin && adminEmail) {
      saga.addStep(
        'create_first_admin',
        async () => {
          const adminResult = await this.createFirstAdminUser(
            tenant.id,
            adminEmail,
            adminFirstName || 'Admin',
            adminLastName || 'User',
          );

          if (!adminResult.success) {
            // Admin creation failure is non-fatal — log and continue
            this.logger.warn(
              `Could not create first admin for tenant ${tenantId}: ${adminResult.error}`,
            );
            return;
          }

          // Store admin user info (without invitationToken — it only travels via email)
          adminUser = {
            userId: adminResult.userId!,
            email: adminEmail,
          };

          // Send invitation email with the raw token
          await this.sendAdminInvitationEmail(
            adminEmail,
            adminFirstName || 'Admin',
            adminLastName || 'User',
            tenant.name,
            adminResult.invitationToken!,
          );
        },
        async () => {
          // Compensate: delete the admin user and invitation
          this.logger.warn(`Compensating: deleting admin user for tenant ${tenant.id}`);
          await this.dataSource.query(
            `DELETE FROM auth.users WHERE "tenantId" = $1 AND role = 'TENANT_ADMIN'`,
            [tenant.id],
          ).catch((err: Error) => {
            this.logger.error(`Failed to delete admin user during compensation: ${err.message}`);
          });
          await this.dataSource.query(
            `DELETE FROM auth.invitations WHERE "tenantId" = $1`,
            [tenant.id],
          ).catch((err: Error) => {
            this.logger.error(`Failed to delete invitations during compensation: ${err.message}`);
          });
        },
      );
    }

    // Step: Activate tenant (persist the ACTIVE status set atomically above)
    saga.addStep(
      'activate_tenant',
      async () => {
        tenant.status = TenantStatus.ACTIVE;
        await this.tenantRepository.save(tenant);
      },
      async () => {
        // Compensate: revert tenant to PENDING
        this.logger.warn(`Compensating: reverting tenant ${tenant.id} to PENDING`);
        await this.dataSource.query(
          `UPDATE auth.tenants SET status = $1, "updatedAt" = NOW() WHERE id = $2`,
          [TenantStatus.PENDING, tenant.id],
        );
      },
    );

    // Execute the saga
    const sagaResult: SagaResult = await saga.run();

    // Map saga result to ProvisioningResult
    const provisioningSteps: ProvisioningStep[] = sagaResult.steps.map((s) => ({
      name: s.name,
      status: s.status === 'completed' ? 'completed'
        : s.status === 'failed' ? 'failed'
        : s.status === 'compensated' ? 'failed'
        : s.status === 'compensation_failed' ? 'failed'
        : 'pending',
      duration: s.duration,
      error: s.error,
    }));

    if (sagaResult.success) {
      this.logger.log(`Tenant ${tenantId} provisioned successfully`);
    } else {
      this.logger.error(
        `Tenant ${tenantId} provisioning failed at step [${sagaResult.failedStep}]: ${sagaResult.error}`,
      );
    }

    return {
      success: sagaResult.success,
      tenantId,
      steps: provisioningSteps,
      error: sagaResult.error,
      compensationErrors: sagaResult.compensationErrors.length > 0 ? sagaResult.compensationErrors : undefined,
      adminUser: sagaResult.success ? adminUser : undefined,
    };
  }

  /**
   * Send invitation email to the new admin user.
   * Extracted from provisionTenant for clarity and testability.
   */
  private async sendAdminInvitationEmail(
    email: string,
    firstName: string,
    lastName: string,
    tenantName: string,
    rawInvitationToken: string,
  ): Promise<void> {
    if (!this.emailSenderService) {
      this.logger.warn('EmailSenderService not available, invitation email not sent');
      return;
    }

    try {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      const emailResult = await this.emailSenderService.sendInvitationEmail({
        email,
        firstName,
        lastName,
        tenantName,
        invitationToken: rawInvitationToken,
        role: 'TENANT_ADMIN',
        expiresAt,
      });

      if (emailResult.success) {
        this.logger.log(`Invitation email sent to ${email}`);
      } else {
        this.logger.warn(`Failed to send invitation email to ${email}: ${emailResult.error}`);
      }
    } catch (emailError) {
      this.logger.warn(`Error sending invitation email: ${(emailError as Error).message}`);
    }
  }

  /**
   * Deprovision a tenant and clean up resources
   */
  async deprovisionTenant(tenantId: string): Promise<ProvisioningResult> {
    // LEGAL-HIGH-006 cure: BEFORE any deprovisioning step (backup,
    // resource removal, schema cleanup), assert no legal hold is
    // active. The cleanupTenantSchema step issues DROP SCHEMA which
    // is irreversible at the DB level — once the schema is gone,
    // legal-hold preservation has nothing to restore. Throwing here
    // (LegalHoldActiveError) bubbles up as a 4xx to the operator
    // with a clear "release the hold first" signal.
    if (this.legalHoldService) {
      await this.legalHoldService.assertNoHold(tenantId, 'tenant');
    }

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

    // Query assigned modules for this tenant from auth.tenant_modules → auth.modules
    // Only create tables for modules the tenant has actually been assigned
    let modulesToCreate: string[];
    try {
      const assignedModules: { code: string }[] = await this.dataSource.query(
        `SELECT m.code FROM auth.tenant_modules tm
         JOIN auth.modules m ON m.id = tm."moduleId"
         WHERE tm."tenantId" = $1 AND tm."isEnabled" = true`,
        [tenant.id],
      );
      modulesToCreate = assignedModules.length > 0
        ? assignedModules.map((m) => m.code)
        : DEFAULT_TENANT_MODULES;

      if (assignedModules.length > 0) {
        this.logger.log(
          `Creating schema with assigned modules: ${modulesToCreate.join(', ')}`,
        );
      } else {
        this.logger.warn(
          `No assigned modules found for tenant ${tenant.id}, falling back to all modules`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Failed to query assigned modules for tenant ${tenant.id}, falling back to all modules: ${(error as Error).message}`,
      );
      modulesToCreate = DEFAULT_TENANT_MODULES;
    }

    // Create tenant schema with the determined module tables
    const result = await this.schemaManager.createTenantSchema(tenant.id, modulesToCreate);

    if (!result.success) {
      throw new Error(`Schema creation failed: ${result.errors.join(', ')}`);
    }

    this.logger.log(
      `Created tenant schema ${result.schemaName} with ${result.tablesCreated.length} tables in ${result.duration}ms`,
    );

    // Track the schema in admin.tenant_schemas for visibility and management
    await this.trackTenantSchema(
      tenant.id,
      result.schemaName,
      result.tablesCreated.length,
      result.alreadyExists,
    );
  }

  /**
   * Insert or update a tracking record in admin.tenant_schemas after schema creation.
   * This is critical for admin dashboard visibility, migration tracking,
   * and knowing which tenant schemas exist without querying information_schema.
   */
  private async trackTenantSchema(
    tenantId: string,
    schemaName: string,
    tableCount: number,
    alreadyExists?: boolean,
  ): Promise<void> {
    try {
      // Check if a tracking record already exists (e.g., from a previous partial provisioning)
      const existing = await this.tenantSchemaRepository.findOne({
        where: { tenantId },
      });

      if (existing) {
        // Update existing record to active
        existing.status = 'active' as SchemaStatus;
        existing.tableCount = tableCount || existing.tableCount;
        await this.tenantSchemaRepository.save(existing);
        this.logger.log(
          `Updated tenant_schemas tracking record for tenant ${tenantId} (schema: ${schemaName})`,
        );
      } else {
        // Insert new tracking record
        const schemaRecord = this.tenantSchemaRepository.create({
          tenantId,
          schemaName,
          status: 'active' as SchemaStatus,
          currentVersion: '1.0.0',
          tableCount: tableCount || 0,
        });
        await this.tenantSchemaRepository.save(schemaRecord);
        this.logger.log(
          `Created tenant_schemas tracking record for tenant ${tenantId} (schema: ${schemaName}, tables: ${tableCount})`,
        );
      }
    } catch (error) {
      // Log but don't fail provisioning — the actual schema was already created successfully.
      // The tracking record can be backfilled later.
      this.logger.warn(
        `Failed to create tenant_schemas tracking record for tenant ${tenantId}: ${(error as Error).message}`,
      );
    }
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
          `SELECT id FROM auth.tenant_roles WHERE "tenantId" = $1 AND code = $2`,
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
          INSERT INTO auth.tenant_roles (
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
        CREATE TABLE IF NOT EXISTS auth.tenant_roles (
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
            REFERENCES auth.tenants(id) ON DELETE CASCADE
        )
      `);

      // Create indexes for better query performance
      await this.dataSource.query(`
        CREATE INDEX IF NOT EXISTS idx_tenant_roles_tenant_id
        ON auth.tenant_roles("tenantId")
      `);

      await this.dataSource.query(`
        CREATE INDEX IF NOT EXISTS idx_tenant_roles_code
        ON auth.tenant_roles(code)
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
      FROM auth.tenant_roles
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
      FROM auth.tenant_roles
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
    throw new NotImplementedException(
      `Tenant data backup not yet implemented for tenant ${tenant.id}. Track: BACKLOG-001`,
    );
  }

  private async removeTenantResources(tenant: Tenant): Promise<void> {
    throw new NotImplementedException(
      `Tenant resource removal not yet implemented for tenant ${tenant.id}. Track: BACKLOG-002`,
    );
  }

  private async cleanupTenantSchema(tenant: Tenant): Promise<void> {
    this.logger.log(`Cleaning up schema for tenant ${tenant.id}`);

    const result = await this.schemaManager.deleteTenantSchema(tenant.id);
    if (!result.success) {
      throw new Error(`Schema cleanup failed: ${result.error}`);
    }

    // Update the tracking record to reflect deletion
    try {
      const schemaRecord = await this.tenantSchemaRepository.findOne({
        where: { tenantId: tenant.id },
      });
      if (schemaRecord) {
        schemaRecord.status = 'deleted' as SchemaStatus;
        await this.tenantSchemaRepository.save(schemaRecord);
        this.logger.log(`Marked tenant_schemas tracking record as deleted for tenant ${tenant.id}`);
      }
    } catch (error) {
      this.logger.warn(
        `Failed to update tenant_schemas tracking record during cleanup for tenant ${tenant.id}: ${(error as Error).message}`,
      );
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
        `SELECT id FROM auth.users WHERE LOWER(email) = LOWER($1)`,
        [email],
      );

      if (existingUser && existingUser.length > 0) {
        return {
          success: false,
          error: 'A user with this email already exists',
        };
      }

      // Generate invitation token — raw token goes to email, SHA-256 hash goes to DB.
      // This follows the auth-service pattern: if the DB is compromised, the attacker
      // cannot use the hashed tokens to accept invitations.
      const rawInvitationToken = crypto.randomBytes(32).toString('hex');
      const hashedToken = crypto.createHash('sha256').update(rawInvitationToken).digest('hex');
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

      // Create user in transaction
      const result = await this.dataSource.transaction(async (manager) => {
        // Create user with hashed invitation token
        const userResult = await manager.query(
          `
          INSERT INTO auth.users (
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
          [email, firstName, lastName, tenantId, hashedToken, expiresAt],
        );

        const userId = userResult[0].id;

        // Create invitation record with hashed token
        await manager.query(
          `
          INSERT INTO auth.invitations (
            id, token, email, "firstName", "lastName", role, "tenantId",
            status, "expiresAt", "invitedBy", "sendCount", "lastSentAt", "createdAt", "updatedAt"
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4, 'TENANT_ADMIN', $5,
            'PENDING', $6, $7, 1, NOW(), NOW(), NOW()
          )
        `,
          [hashedToken, email, firstName, lastName, tenantId, expiresAt, userId],
        );

        // Update tenant user count
        await manager.query(
          `UPDATE auth.tenants SET user_count = 1 WHERE id = $1`,
          [tenantId],
        );

        return { userId };
      });

      // Create user permissions with TENANT_ADMIN_PERMISSIONS
      // grantedBy is UUID type — use null for system-provisioned users
      await this.userPermissionsService.createDefaultPermissions(
        result.userId,
        tenantId,
        undefined, // grantedBy: omitted for system provisioning (column is nullable UUID)
        true, // isAdmin - true to use TENANT_ADMIN_PERMISSIONS
      );

      this.logger.log(
        `Created first admin user for tenant ${tenantId}: ${email} with TENANT_ADMIN permissions`,
      );

      return {
        success: true,
        userId: result.userId,
        invitationToken: rawInvitationToken, // Raw token for email — DB stores only the hash
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
        `INSERT INTO auth.tenant_modules (id, "tenantId", "moduleId", "isEnabled", "activatedAt", "createdAt", "updatedAt")
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

  /**
   * Seed default water quality parameter configs for a new tenant.
   * Inserts a comprehensive set of common aquaculture parameters that
   * works for most species. Tenant admins can add, remove, or customize
   * parameters after provisioning via the Parameters tab.
   */
  private async seedDefaultWaterQualityParams(tenantId: string): Promise<void> {
    this.logger.log(`Seeding default water quality parameters for tenant ${tenantId}`);
    const schemaName = `tenant_${tenantId.replace(/-/g, '_')}`;
    // C-ADMIN-01: Validate schemaName as a safe SQL identifier before use.
    // tenantId is a UUID so this always passes, but the guard prevents
    // future callers from accidentally passing unsanitized input.
    const safeIdentifierRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    if (!safeIdentifierRegex.test(schemaName) || schemaName.length > 63) {
      throw new Error(`SECURITY: Unsafe schema name derived from tenantId '${tenantId}'`);
    }

    // Common aquaculture parameters — covers freshwater + seawater basics
    const params = [
      { code: 'temperature', name: 'Temperature', unit: '°C', precision: 1, group: 'basic', optMin: 8, optMax: 20, warnMin: 4, warnMax: 24, critMin: 2, critMax: 28, color: '#3b82f6', order: 1, required: true, axis: 'left' },
      { code: 'dissolved_oxygen', name: 'Dissolved Oxygen', unit: 'mg/L', precision: 1, group: 'basic', optMin: 6, optMax: 12, warnMin: 4.5, warnMax: 14, critMin: 3, critMax: 16, color: '#22c55e', order: 2, required: true, axis: 'left' },
      { code: 'ph', name: 'pH', unit: '', precision: 2, group: 'basic', optMin: 6.5, optMax: 8.5, warnMin: 6.0, warnMax: 9.0, critMin: 5.5, critMax: 9.5, color: '#8b5cf6', order: 3, required: true, axis: 'left' },
      { code: 'ammonia', name: 'Ammonia (NH₃)', unit: 'mg/L', precision: 3, group: 'nitrogen_cycle', optMin: 0, optMax: 0.02, warnMin: 0, warnMax: 0.05, critMin: 0, critMax: 0.1, color: '#ef4444', order: 4, required: true, axis: 'right' },
      { code: 'nitrite', name: 'Nitrite (NO₂)', unit: 'mg/L', precision: 3, group: 'nitrogen_cycle', optMin: 0, optMax: 0.1, warnMin: 0, warnMax: 0.3, critMin: 0, critMax: 0.5, color: '#f97316', order: 5, required: true, axis: 'right' },
      { code: 'nitrate', name: 'Nitrate (NO₃)', unit: 'mg/L', precision: 1, group: 'nitrogen_cycle', optMin: 0, optMax: 50, warnMin: 0, warnMax: 80, critMin: 0, critMax: 100, color: '#eab308', order: 6, required: false, axis: 'right' },
      { code: 'salinity', name: 'Salinity', unit: 'ppt', precision: 1, group: 'basic', optMin: 0, optMax: 38, warnMin: 0, warnMax: 42, critMin: 0, critMax: 45, color: '#0891b2', order: 7, required: false, axis: 'left' },
      { code: 'alkalinity', name: 'Alkalinity', unit: 'mg/L CaCO₃', precision: 0, group: 'basic', optMin: 40, optMax: 200, warnMin: 20, warnMax: 300, critMin: 10, critMax: 400, color: '#a855f7', order: 8, required: false, axis: 'left' },
      { code: 'turbidity', name: 'Turbidity', unit: 'NTU', precision: 1, group: 'basic', optMin: 0, optMax: 10, warnMin: 0, warnMax: 25, critMin: 0, critMax: 50, color: '#78716c', order: 9, required: false, axis: 'left' },
      { code: 'co2', name: 'Carbon Dioxide', unit: 'mg/L', precision: 1, group: 'basic', optMin: 0, optMax: 15, warnMin: 0, warnMax: 25, critMin: 0, critMax: 40, color: '#06b6d4', order: 10, required: false, axis: 'right' },
      { code: 'oxygen_saturation', name: 'Oxygen Saturation', unit: '%', precision: 0, group: 'basic', optMin: 70, optMax: 120, warnMin: 50, warnMax: 130, critMin: 30, critMax: 150, color: '#16a34a', order: 11, required: false, axis: 'left' },
      { code: 'conductivity', name: 'Conductivity', unit: 'µS/cm', precision: 0, group: 'basic', optMin: 50, optMax: 800, warnMin: 20, warnMax: 1200, critMin: 10, critMax: 2000, color: '#14b8a6', order: 12, required: false, axis: 'right' },
    ];

    try {
      // C-ADMIN-01: Individual parameterized inserts — no string interpolation of
      // param values. schemaName (SQL identifier) is validated above and used
      // with double-quote quoting per PostgreSQL identifier rules.
      for (const p of params) {
        await this.dataSource.query(
          `INSERT INTO "${schemaName}".water_quality_parameter_configs
             (id, "tenantId", code, name, unit, "dataType", precision, "group",
              "optimalMin", "optimalMax", "warningMin", "warningMax", "criticalMin", "criticalMax",
              "chartColor", "displayOrder", "isVisible", "isRequired", "isActive", "chartAxisGroup",
              "isQuickAccess", "templateSource", "createdAt", "updatedAt")
           VALUES
             (gen_random_uuid(), $1, $2, $3, $4, 'number', $5, $6,
              $7, $8, $9, $10, $11, $12,
              $13, $14, $15, $15, true, $16,
              false, 'default_seed', NOW(), NOW())
           ON CONFLICT ("tenantId", code) DO NOTHING`,
          [tenantId, p.code, p.name, p.unit, p.precision, p.group,
           p.optMin, p.optMax, p.warnMin, p.warnMax, p.critMin, p.critMax,
           p.color, p.order, p.required, p.axis],
        );
      }

      this.logger.log(`Seeded ${params.length} default water quality parameters for tenant ${tenantId}`);
    } catch (error) {
      this.logger.warn(
        `Failed to seed water quality params for tenant ${tenantId}: ${(error as Error).message}. ` +
        `Tenant can manually configure parameters via the Parameters tab.`,
      );
      // Non-fatal — tenant can still use the system, just needs to set up params manually
    }
  }
}
