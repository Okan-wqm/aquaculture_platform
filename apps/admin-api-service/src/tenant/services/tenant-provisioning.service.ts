import * as crypto from 'crypto';

import { LegalHoldService } from '@aquaculture/backend-common/compliance';
import {
  createCleanupDropProof,
  getTenantSchemaName,
  queryRowsNormalized,
  validateSqlIdentifier,
} from '@aquaculture/backend-common/database';
import type {
  CleanupDropProof,
  CleanupDropProofRecoveryPoint,
} from '@aquaculture/backend-common/database';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { TenantSchema } from '../../database-management/entities/database-management.entity';
import { WalgRecoveryPointService } from '../../database-management/services/recovery-point.service';
import { TenantConfigurationService } from '../../settings/services/tenant-configuration.service';
import { Tenant, TenantStatus } from '../entities/tenant.entity';

import { AuthTenantProvisioningClientService } from './auth-tenant-provisioning-client.service';
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
  warnings?: string[];
  compensationErrors?: Array<{ step: string; error: string }>;
  adminUser?: {
    userId: string;
    email: string;
    // NOTE: invite credential material is intentionally omitted from result.
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
  finalizeActivation?: boolean;
  operationId?: string;
  idempotencyKeyBase?: string;
  payloadHash?: string;
  actorId?: string;
}

interface AuthProvisioningCommandContext {
  operationId: string;
  idempotencyKeyBase: string;
  actorId: string;
  requestPayloadHash: string;
}

interface TenantRoleRow {
  id?: unknown;
  code?: unknown;
  name?: unknown;
  description?: unknown;
  permissions?: unknown;
  is_default?: unknown;
  is_editable?: unknown;
  display_order?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

interface CountRow {
  count?: unknown;
}

interface TenantSchemaCleanupRow {
  schemaName?: unknown;
}

interface NamespaceRow {
  nspname?: unknown;
}

interface IdRow {
  id?: unknown;
}

@Injectable()
export class TenantProvisioningService {
  private readonly logger = new Logger(TenantProvisioningService.name);

  /**
   * Default roles to be created for each tenant during provisioning.
   * Only TENANT_ADMIN role is created - actual permissions are managed by the
   * auth-service tenant RBAC (auth.tenant_role_permissions.panel_permissions, ADR-042).
   */
  private readonly defaultRoles: DefaultTenantRole[] = [
    {
      code: 'TENANT_ADMIN',
      name: 'Tenant Administrator',
      description:
        'Full administrative access to all tenant features. Can manage users and assign permissions.',
      permissions: ['*'], // Full access - actual permissions managed by auth tenant RBAC (ADR-042)
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
    private readonly recoveryPointService: WalgRecoveryPointService,
    private readonly authProvisioningClient: AuthTenantProvisioningClientService,
    @Optional()
    private readonly legalHoldService?: LegalHoldService,
  ) {}

  private rowsFromQuery<T extends object>(value: unknown): T[] {
    return queryRowsNormalized<T>(value);
  }

  private readString(value: unknown): string {
    if (value == null) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return value.toString();
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    return '';
  }

  private readBoolean(value: unknown): boolean {
    return value === true || value === 'true' || value === 1 || value === '1';
  }

  private readNumber(value: unknown): number {
    return Number(value ?? 0);
  }

  private readDate(value: unknown): Date {
    if (value instanceof Date) {
      return value;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      return new Date(value);
    }
    return new Date(0);
  }

  private parseRolePermissions(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.filter((permission): permission is string => typeof permission === 'string');
    }
    if (typeof value !== 'string') {
      return [];
    }

    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((permission): permission is string => typeof permission === 'string')
      : [];
  }

  private toTenantStatus(status: string): TenantStatus | undefined {
    return Object.values(TenantStatus).find((candidate) => String(candidate) === status);
  }

  /**
   * Provision a new tenant with all required resources.
   *
   * Uses ProvisioningSagaService to orchestrate steps with compensating
   * transactions. On failure, completed steps are rolled back in reverse.
   *
   * Auth-owned identity writes are delegated to auth-service via NATS
   * request-reply commands from @platform/event-contracts/tenant-commands.
   * admin-api owns orchestration and tenant schemas; auth-service remains
   * the single writer for auth.users, auth.invitations, auth.tenant_roles,
   * and auth.tenant_modules.
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
      skipSchemaCreation = true,
      finalizeActivation = true,
      operationId = crypto.randomUUID(),
      idempotencyKeyBase = `manual-provision:${tenantId}:${operationId}`,
      payloadHash = this.hashPayload({ tenantId, options }),
      actorId,
    } = options;
    const authCommandContext: AuthProvisioningCommandContext = {
      operationId,
      idempotencyKeyBase,
      actorId: actorId ?? tenantId,
      requestPayloadHash: payloadHash,
    };

    // Pre-flight: validate tenant exists and is in PENDING state
    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
    });

    if (!tenant) {
      return {
        success: false,
        tenantId,
        steps: [
          { name: 'validate_tenant', status: 'failed', error: `Tenant ${tenantId} not found` },
        ],
        error: `Tenant ${tenantId} not found`,
      };
    }

    const retryableStatuses = new Set<string>([
      TenantStatus.PENDING,
      TenantStatus.PROVISIONING_FAILED,
      ...(finalizeActivation === false ? [TenantStatus.PROVISIONING] : []),
    ]);
    if (!retryableStatuses.has(tenant.status)) {
      return {
        success: false,
        tenantId,
        steps: [
          {
            name: 'validate_tenant',
            status: 'failed',
            error: `Tenant status must be PENDING, got ${tenant.status}`,
          },
        ],
        error: `Tenant status must be PENDING, got ${tenant.status}`,
      };
    }

    // Build the saga with steps + compensating actions
    const saga = new ProvisioningSagaService();
    let adminUser: ProvisioningResult['adminUser'] | undefined;
    const warnings: string[] = [];

    // Step: Assign modules (optional, before schema creation)
    if (assignModules.length > 0) {
      saga.addStep(
        'assign_modules',
        async () => {
          await this.assignModulesToTenant(tenant.id, assignModules, authCommandContext);
        },
        async () => {
          await this.rollbackAuthProvisioning(
            tenant.id,
            ['assign_modules'],
            'module assignment compensation',
            {
              ...authCommandContext,
              actorId: actorId ?? tenant.createdBy ?? authCommandContext.actorId,
            },
          );
        },
      );
    }

    // Step: Verify tenant schema ownership boundary.
    if (!skipSchemaCreation) {
      saga.addStep(
        'create_schema',
        () => {
          return this.createTenantSchema(tenant);
        },
        async () => {
          // A rollback of a schema that never held tenant data carries no
          // recovery point: there is nothing to restore, and the previous
          // synthetic "encrypted backup" here was evidence of nothing.
          const proof = createCleanupDropProof({
            operationId: authCommandContext.operationId,
            tenantId: tenant.id,
            purpose: 'provisioning_rollback',
            actorId: authCommandContext.actorId,
            reason: 'tenant provisioning create_schema compensation',
            legalHoldCheckedAt: new Date(),
          });
          const schemaRecord = await this.tenantSchemaRepository.findOne({
            where: { tenantId: tenant.id },
          });
          if (schemaRecord) {
            schemaRecord.status = 'pending_deletion';
            schemaRecord.metadata = {
              ...(schemaRecord.metadata ?? {}),
              cleanupOperationId: proof.operationId,
              cleanupRequestedAt: new Date().toISOString(),
              cleanupProofPurpose: proof.purpose,
              cleanupProofCreatedAt: proof.createdAt,
            };
            await this.tenantSchemaRepository.save(schemaRecord);
          }
          this.logger.warn(
            `Schema compensation for tenant ${tenant.id} is db-migrate owned; admin-api did not issue DDL`,
          );
        },
      );
    } else {
      saga.addStep('create_schema', () => {
        this.logger.log(
          `Skipping schema creation for tenant ${tenantId} (skipSchemaCreation=true)`,
        );
      });
    }

    saga.addStep(
      'setup_default_roles',
      async () => {
        await this.setupDefaultRoles(tenant, authCommandContext);
      },
      async () => {
        await this.rollbackAuthProvisioning(
          tenant.id,
          ['setup_roles'],
          'tenant role setup compensation',
          {
            ...authCommandContext,
            actorId: actorId ?? tenant.createdBy ?? authCommandContext.actorId,
          },
        );
      },
    );

    // Step: Create default configuration
    saga.addStep(
      'create_default_config',
      () => {
        return this.createDefaultConfiguration(tenant);
      },
      () => {
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
          const schemaName = validateSqlIdentifier(getTenantSchemaName(tenant.id), 'schema');
          await this.dataSource
            .query(
              `DELETE FROM "${schemaName}".water_quality_parameter_configs WHERE "tenantId" = $1`,
              [tenant.id],
            )
            .catch((err: Error) => {
              this.logger.error(`Failed to remove water quality params: ${err.message}`);
            });
        },
      );
    }

    if (createFirstAdmin && adminEmail) {
      saga.addStep(
        'create_first_admin',
        async () => {
          const adminResult = await this.createFirstAdminUser(
            tenant.id,
            adminEmail,
            adminFirstName || 'Admin',
            adminLastName || 'User',
            {
              ...authCommandContext,
              actorId: actorId ?? tenant.createdBy ?? authCommandContext.actorId,
            },
          );

          if (!adminResult.success || !adminResult.userId) {
            throw new Error(
              `Could not create first admin for tenant ${tenantId}: ${adminResult.error ?? 'missing user id'}`,
            );
          }

          adminUser = {
            userId: adminResult.userId,
            email: adminEmail,
          };
        },
        async () => {
          await this.rollbackAuthProvisioning(
            tenant.id,
            ['create_admin'],
            'first admin compensation',
            {
              ...authCommandContext,
              actorId: actorId ?? tenant.createdBy ?? authCommandContext.actorId,
            },
          );
        },
      );
    }

    if (finalizeActivation) {
      // Manual provisioning can still finalize inside this service. The async
      // tenant-create workflow passes finalizeActivation=false and activates
      // only after its outer RLS, billing, audit and event steps succeed.
      saga.addStep(
        'activate_tenant',
        async () => {
          await this.authProvisioningClient.activateTenant({
            ...this.buildAuthCommandMetadata('ActivateTenant', tenant.id, authCommandContext, {
              finalizeActivation: true,
            }),
          });
        },
        () => {
          this.logger.warn(
            `Compensating: tenant ${tenant.id} activation is auth-owned; leaving status transition evidence intact`,
          );
        },
      );
    }

    // Execute the saga
    const sagaResult: SagaResult = await saga.run();

    // Map saga result to ProvisioningResult
    const provisioningSteps: ProvisioningStep[] = sagaResult.steps.map((s) => ({
      name: s.name,
      status:
        s.status === 'completed'
          ? 'completed'
          : s.status === 'failed'
            ? 'failed'
            : s.status === 'compensated'
              ? 'failed'
              : s.status === 'compensation_failed'
                ? 'failed'
                : 'pending',
      duration: s.duration,
      error: s.error,
    }));

    if (sagaResult.success) {
      this.logger.log(`Tenant ${tenantId} provisioned successfully`);
    } else {
      await this.authProvisioningClient.failProvisioning({
        ...this.buildAuthCommandMetadata('FailProvisioning', tenantId, authCommandContext, {
          failedStep: sagaResult.failedStep,
          error: sagaResult.error,
        }),
        reason: sagaResult.error ?? 'Tenant provisioning failed',
      });
      this.logger.error(
        `Tenant ${tenantId} provisioning failed at step [${sagaResult.failedStep}]: ${sagaResult.error}`,
      );
    }

    return {
      success: sagaResult.success,
      tenantId,
      steps: provisioningSteps,
      error: sagaResult.error,
      warnings: warnings.length > 0 ? warnings : undefined,
      compensationErrors:
        sagaResult.compensationErrors.length > 0 ? sagaResult.compensationErrors : undefined,
      adminUser: sagaResult.success ? adminUser : undefined,
    };
  }

  /**
   * Deprovision a tenant and clean up resources
   */
  async deprovisionTenant(tenantId: string): Promise<ProvisioningResult> {
    const steps: ProvisioningStep[] = [
      { name: 'validate_tenant', status: 'pending' },
      { name: 'capture_recovery_point', status: 'pending' },
      { name: 'remove_resources', status: 'pending' },
      { name: 'cleanup_schema', status: 'pending' },
    ];

    const preCounts = await this.collectTenantCleanupCounts(tenantId);
    const cleanupRunId = await this.createCleanupRun(tenantId, preCounts);
    const cleanupAuthCommandContext: AuthProvisioningCommandContext = {
      operationId: cleanupRunId,
      idempotencyKeyBase: `tenant-cleanup:${tenantId}:${cleanupRunId}`,
      actorId: 'tenant-deprovision-workflow',
      requestPayloadHash: this.hashPayload({ tenantId, cleanupRunId, preCounts }),
    };

    const updateStep = async (
      index: number,
      status: ProvisioningStep['status'],
      error?: string,
    ): Promise<void> => {
      const step = steps[index];
      if (step) {
        step.status = status;
        if (error !== undefined) step.error = error;
        await this.recordCleanupStep(cleanupRunId, step.name, status, error);
      }
    };

    try {
      // Legal hold is the first non-ledger gate before any recovery-point
      // capture, delete, or schema drop. It is not optional; if the canonical service cannot answer,
      // destructive cleanup cannot run.
      if (!this.legalHoldService) {
        throw new Error('LegalHoldService is required before tenant cleanup can run');
      }
      await this.legalHoldService.assertNoHold(tenantId, 'tenant');
      await this.markCleanupRunLegalHoldChecked(cleanupRunId);

      const tenant = await this.tenantRepository.findOne({
        where: { id: tenantId },
      });

      if (!tenant) {
        await updateStep(0, 'failed', `Tenant ${tenantId} not found`);
        await this.finishCleanupRun(cleanupRunId, 'FAILED', {
          error: `Tenant ${tenantId} not found`,
          postCounts: await this.collectTenantCleanupCounts(tenantId),
        });
        return {
          success: false,
          tenantId,
          steps,
          error: `Tenant ${tenantId} not found`,
        };
      }

      // Validate tenant can be deprovisioned
      await updateStep(0, 'in_progress');
      if (this.toTenantStatus(tenant.status) === TenantStatus.ACTIVE) {
        await updateStep(0, 'failed', 'Cannot deprovision an active tenant');
        await this.finishCleanupRun(cleanupRunId, 'FAILED', {
          error: 'Cannot deprovision an active tenant',
          postCounts: await this.collectTenantCleanupCounts(tenantId),
        });
        return { success: false, tenantId, steps };
      }
      await updateStep(0, 'completed');

      // Recovery point (ADR-0009): the WAL-G archive epoch and WAL position the
      // tenant's data exists at, captured before anything is removed. This is
      // what the PITR workflow restores from; it replaces the in-process
      // pg_dump that never completed in production.
      await updateStep(1, 'in_progress');
      const recoveryPoint = await this.recoveryPointService.capture();
      await this.attachCleanupRecoveryPoint(cleanupRunId, recoveryPoint);
      await updateStep(1, 'completed');
      const dropProof = this.createDeprovisionDropProof({
        tenant,
        cleanupRunId,
        recoveryPoint,
        preCounts,
      });

      // Remove resources
      await updateStep(2, 'in_progress');
      await this.removeTenantResources(tenant, cleanupAuthCommandContext);
      await updateStep(2, 'completed');

      // Cleanup schema
      await updateStep(3, 'in_progress');
      await this.cleanupTenantSchema(tenant, dropProof, cleanupRunId);
      await updateStep(3, 'completed');

      await this.finishCleanupRun(cleanupRunId, 'PENDING_DB_MIGRATE', {
        postCounts: await this.collectTenantCleanupCounts(tenantId),
      });

      this.logger.log(`Tenant ${tenantId} deprovisioning accepted for db-migrate schema cleanup`);

      return {
        success: true,
        tenantId,
        steps,
        warnings: ['Tenant schema cleanup is queued for aqua-db-migrate'],
      };
    } catch (error) {
      const currentStep = steps.find((s) => s.status === 'in_progress');
      if (currentStep) {
        currentStep.status = 'failed';
        currentStep.error = (error as Error).message;
        await this.recordCleanupStep(cleanupRunId, currentStep.name, 'failed', currentStep.error);
      }
      await this.finishCleanupRun(
        cleanupRunId,
        this.isLegalHoldError(error) ? 'DENIED' : 'FAILED',
        {
          error: (error as Error).message,
          postCounts: await this.collectTenantCleanupCounts(tenantId),
        },
      );

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
  async getProvisioningStatus(tenantId: string): Promise<{ status: string; tenant?: Tenant }> {
    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
    });

    if (!tenant) {
      return { status: 'not_found' };
    }

    switch (this.toTenantStatus(tenant.status)) {
      case TenantStatus.PENDING:
        return { status: 'pending', tenant };
      case TenantStatus.PROVISIONING:
        return { status: 'provisioning', tenant };
      case TenantStatus.PROVISIONING_FAILED:
        return { status: 'failed', tenant };
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

  private createTenantSchema(tenant: Tenant): never {
    this.logger.warn(
      `Rejecting runtime schema creation for tenant ${tenant.id}; tenant schema provisioning is db-migrate owned`,
    );
    throw new Error(
      `Tenant schema creation for ${tenant.id} is owned by aqua-db-migrate; ` +
        `admin-api must create a provisioning ledger request and wait for admin.tenant_schemas.`,
    );
  }

  /**
   * Setup default roles for a newly provisioned tenant.
   * Creates only the TENANT_ADMIN role - actual permissions are managed by the
   * auth-service tenant RBAC (auth.tenant_role_permissions.panel_permissions, ADR-042).
   */
  private async setupDefaultRoles(
    tenant: Tenant,
    context: AuthProvisioningCommandContext,
  ): Promise<void> {
    this.logger.log(`Setting up default roles for tenant ${tenant.id}`);

    const result = await this.authProvisioningClient.setupTenantRoles({
      ...this.buildAuthCommandMetadata('SetupRoles', tenant.id, context, {
        roles: this.defaultRoles,
      }),
      roles: this.defaultRoles,
      createdBy: tenant.createdBy,
    });

    this.logger.log(
      `Successfully ensured tenant default roles for ${tenant.id}; created=${result.rolesCreated ?? 0}`,
    );
  }

  /**
   * Get default roles for a tenant
   */
  async getTenantRoles(
    tenantId: string,
  ): Promise<Array<DefaultTenantRole & { id: string; createdAt: Date; updatedAt: Date }>> {
    const roles = this.rowsFromQuery<TenantRoleRow>(
      await this.dataSource.query(
        `
      SELECT id, "tenantId", code, name, description, permissions,
             is_default, is_editable, display_order, created_at, updated_at
      FROM auth.tenant_roles
      WHERE "tenantId" = $1
      ORDER BY display_order ASC
    `,
        [tenantId],
      ),
    );

    return roles.map((row) => ({
      id: this.readString(row.id),
      code: this.readString(row.code),
      name: this.readString(row.name),
      description: this.readString(row.description),
      permissions: this.parseRolePermissions(row.permissions),
      isDefault: this.readBoolean(row.is_default),
      isEditable: this.readBoolean(row.is_editable),
      displayOrder: this.readNumber(row.display_order),
      createdAt: this.readDate(row.created_at),
      updatedAt: this.readDate(row.updated_at),
    }));
  }

  /**
   * Get a specific role for a tenant by code
   */
  async getTenantRoleByCode(
    tenantId: string,
    roleCode: string,
  ): Promise<(DefaultTenantRole & { id: string }) | null> {
    const roles = this.rowsFromQuery<TenantRoleRow>(
      await this.dataSource.query(
        `
      SELECT id, code, name, description, permissions,
             is_default, is_editable, display_order
      FROM auth.tenant_roles
      WHERE "tenantId" = $1 AND code = $2
    `,
        [tenantId, roleCode],
      ),
    );

    if (roles.length === 0) {
      return null;
    }

    const row = roles[0];
    if (!row) {
      return null;
    }

    return {
      id: this.readString(row.id),
      code: this.readString(row.code),
      name: this.readString(row.name),
      description: this.readString(row.description),
      permissions: this.parseRolePermissions(row.permissions),
      isDefault: this.readBoolean(row.is_default),
      isEditable: this.readBoolean(row.is_editable),
      displayOrder: this.readNumber(row.display_order),
    };
  }

  /**
   * Create default configuration for a newly provisioned tenant
   * Uses the TenantConfigurationService to create the configuration record
   */
  private createDefaultConfiguration(tenant: Tenant): void {
    this.logger.log(`Creating default configuration for tenant ${tenant.id}`);

    try {
      const request = this.tenantConfigurationService.requestDefaultConfigurationProvisioning({
        tenantId: tenant.id,
        brandingConfig: {
          companyName: tenant.name,
        },
        featureFlags: {
          dataExport: true,
          auditLog: true,
          mobileAccess: true,
          iotDeviceSupport: true,
        },
      });

      this.logger.log(
        `Config-service default configuration requested for tenant ${tenant.id}: ${request.requestId}`,
      );
    } catch (error) {
      // If configuration already exists, log and continue
      if ((error as Error).message?.includes('already exists')) {
        this.logger.warn(`Configuration already exists for tenant ${tenant.id}, skipping creation`);
        return;
      }

      this.logger.error(
        `Failed to create configuration for tenant ${tenant.id}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  private async collectTenantCleanupCounts(tenantId: string): Promise<Record<string, unknown>> {
    const queryCount = async (sql: string, params: unknown[] = [tenantId]): Promise<number> => {
      const rows = this.rowsFromQuery<CountRow>(await this.dataSource.query(sql, params));
      const raw = rows[0]?.count ?? 0;
      return Number(raw ?? 0);
    };

    const schemaRows = this.rowsFromQuery<TenantSchemaCleanupRow>(
      await this.dataSource.query(
        `SELECT "schemaName", status
         FROM admin.tenant_schemas
        WHERE "tenantId" = $1
        ORDER BY "updatedAt" DESC`,
        [tenantId],
      ),
    );
    const schemaNames = schemaRows
      .map((row) => this.readString(row.schemaName))
      .filter((name) => name.length > 0);
    const schemaExistsRows =
      schemaNames.length > 0
        ? this.rowsFromQuery<NamespaceRow>(
            await this.dataSource.query(
              `SELECT nspname
             FROM pg_namespace
            WHERE nspname = ANY($1::text[])
            ORDER BY nspname`,
              [schemaNames],
            ),
          )
        : [];

    return {
      tenants: await queryCount(`SELECT COUNT(*) AS count FROM auth.tenants WHERE id = $1`),
      users: await queryCount(`SELECT COUNT(*) AS count FROM auth.users WHERE "tenantId" = $1`),
      invitations: await queryCount(
        `SELECT COUNT(*) AS count FROM auth.invitations WHERE "tenantId" = $1`,
      ),
      tenantModules: await queryCount(
        `SELECT COUNT(*) AS count FROM auth.tenant_modules WHERE "tenantId" = $1`,
      ),
      tenantRoles: await queryCount(
        `SELECT COUNT(*) AS count FROM auth.tenant_roles WHERE "tenantId" = $1`,
      ),
      schemaRecords: schemaRows.length,
      schemaNames,
      existingSchemas: schemaExistsRows.map((row) => this.readString(row.nspname)),
    };
  }

  private async createCleanupRun(
    tenantId: string,
    preCounts: Record<string, unknown>,
  ): Promise<string> {
    const rows = this.rowsFromQuery<IdRow>(
      await this.dataSource.query(
        `INSERT INTO admin.cleanup_runs (
          "tenantId", scope, "actorUserId", status, "preCounts", "createdAt", "updatedAt"
        ) VALUES (
          $1, 'tenant', 'system', 'RUNNING', $2::jsonb, NOW(), NOW()
        )
        RETURNING id`,
        [tenantId, JSON.stringify(preCounts)],
      ),
    );
    const id = this.readString(rows[0]?.id);
    if (!id) {
      throw new Error('Failed to create tenant cleanup ledger run');
    }
    await this.appendCleanupRunEvent(id, 'RUN_CREATED', { tenantId, preCounts });
    await this.appendCleanupRunEvidence(id, 'PRE_COUNTS', preCounts);
    return String(id);
  }

  private async markCleanupRunLegalHoldChecked(cleanupRunId: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE admin.cleanup_runs
          SET "legalHoldCheckedAt" = NOW(), "updatedAt" = NOW()
        WHERE id = $1`,
      [cleanupRunId],
    );
    await this.appendCleanupRunEvent(cleanupRunId, 'LEGAL_HOLD_CHECKED', {});
  }

  private async recordCleanupStep(
    cleanupRunId: string,
    stepName: string,
    status: ProvisioningStep['status'],
    error?: string,
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO admin.cleanup_run_steps (
          "runId", "stepName", status, error, "startedAt", "completedAt", "updatedAt"
        ) VALUES (
          $1, $2, $3, $4,
          CASE WHEN $3 = 'in_progress' THEN NOW() ELSE NULL END,
          CASE WHEN $3 IN ('completed', 'failed') THEN NOW() ELSE NULL END,
          NOW()
        )
        ON CONFLICT ("runId", "stepName") DO UPDATE
          SET status = EXCLUDED.status,
              error = EXCLUDED.error,
              "startedAt" = COALESCE("cleanup_run_steps"."startedAt", EXCLUDED."startedAt"),
              "completedAt" = CASE
                WHEN EXCLUDED.status IN ('completed', 'failed') THEN NOW()
                ELSE "cleanup_run_steps"."completedAt"
              END,
              "updatedAt" = NOW()`,
      [cleanupRunId, stepName, status, error ?? null],
    );
    await this.appendCleanupRunEvent(cleanupRunId, 'STEP_RECORDED', {
      stepName,
      status,
      error: error ?? null,
    });
  }

  private async attachCleanupRecoveryPoint(
    cleanupRunId: string,
    recoveryPoint: CleanupDropProofRecoveryPoint,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE admin.cleanup_runs
          SET "recoveryPointEpoch" = $2,
              "recoveryPointLsn" = $3,
              "recoveryPointCapturedAt" = $4,
              "updatedAt" = NOW()
        WHERE id = $1`,
      [cleanupRunId, recoveryPoint.backupEpoch, recoveryPoint.walLsn, recoveryPoint.capturedAt],
    );
    await this.appendCleanupRunEvidence(cleanupRunId, 'RECOVERY_POINT', { ...recoveryPoint });
  }

  private async finishCleanupRun(
    cleanupRunId: string,
    status: 'PENDING_DB_MIGRATE' | 'SUCCEEDED' | 'FAILED' | 'DENIED',
    options: {
      error?: string;
      postCounts?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE admin.cleanup_runs
          SET status = $2,
              error = $3,
              "postCounts" = COALESCE($4::jsonb, "postCounts"),
              "completedAt" = NOW(),
              "updatedAt" = NOW()
        WHERE id = $1`,
      [
        cleanupRunId,
        status,
        options.error ?? null,
        options.postCounts ? JSON.stringify(options.postCounts) : null,
      ],
    );
    await this.appendCleanupRunEvent(cleanupRunId, 'RUN_FINISHED', {
      status,
      error: options.error ?? null,
    });
    if (options.postCounts) {
      await this.appendCleanupRunEvidence(cleanupRunId, 'POST_COUNTS', options.postCounts);
    }
  }

  private async appendCleanupRunEvent(
    cleanupRunId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO admin.cleanup_run_events ("runId", "eventType", payload, "createdAt")
       VALUES ($1, $2, $3::jsonb, NOW())`,
      [cleanupRunId, eventType, JSON.stringify(payload)],
    );
  }

  private async appendCleanupRunEvidence(
    cleanupRunId: string,
    evidenceType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const evidenceHash = crypto
      .createHash('sha256')
      .update(this.stableStringify(payload))
      .digest('hex');
    await this.dataSource.query(
      `INSERT INTO admin.cleanup_run_evidence ("runId", "evidenceType", "evidenceHash", payload, "createdAt")
       VALUES ($1, $2, $3, $4::jsonb, NOW())`,
      [cleanupRunId, evidenceType, evidenceHash, JSON.stringify(payload)],
    );
  }

  private isLegalHoldError(error: unknown): boolean {
    const err = error as { name?: string; message?: string };
    return (
      err.name === 'LegalHoldActiveError' ||
      (typeof err.message === 'string' && err.message.toLowerCase().includes('legal hold'))
    );
  }

  private async removeTenantResources(
    tenant: Tenant,
    context: AuthProvisioningCommandContext,
  ): Promise<void> {
    await this.authProvisioningClient.rollbackTenantProvisioning({
      ...this.buildAuthCommandMetadata('RollbackProvisioning', tenant.id, context, {
        completedSteps: ['create_admin', 'setup_roles', 'assign_modules'],
        reason: 'tenant deprovision resource cleanup',
      }),
      completedSteps: ['create_admin', 'setup_roles', 'assign_modules'],
      reason: 'tenant deprovision resource cleanup',
    });
  }

  private createDeprovisionDropProof(input: {
    tenant: Tenant;
    cleanupRunId: string;
    recoveryPoint: CleanupDropProofRecoveryPoint;
    preCounts: Record<string, unknown>;
  }): CleanupDropProof {
    return createCleanupDropProof({
      operationId: input.cleanupRunId,
      tenantId: input.tenant.id,
      purpose: 'tenant_deprovision',
      actorId: 'tenant-deprovision-workflow',
      reason: 'tenant deprovision workflow schema cleanup',
      legalHoldCheckedAt: new Date(),
      recoveryPoint: input.recoveryPoint,
      preCounts: input.preCounts,
    });
  }

  private async cleanupTenantSchema(
    tenant: Tenant,
    proof: CleanupDropProof,
    cleanupRunId: string,
  ): Promise<void> {
    this.logger.log(
      `Recording db-migrate schema cleanup request ${cleanupRunId} for tenant ${tenant.id}`,
    );
    if (proof.tenantId !== tenant.id) {
      throw new Error(`Cleanup proof tenant mismatch for ${tenant.id}`);
    }

    const schemaRecord = await this.tenantSchemaRepository.findOne({
      where: { tenantId: tenant.id },
    });
    if (!schemaRecord?.schemaName) {
      throw new Error(
        `Cannot queue schema deletion without tenant_schemas record for ${tenant.id}`,
      );
    }

    const requestedAt = new Date().toISOString();
    await this.dataSource.query(
      `SELECT platform.request_tenant_schema_deletion($1::uuid, $2::uuid, $3::text, $4::jsonb)`,
      [
        cleanupRunId,
        tenant.id,
        schemaRecord.schemaName,
        JSON.stringify({
          cleanupProof: this.serializeCleanupDropProof(proof),
          tombstone: {
            cleanupRunId,
            tenantId: tenant.id,
            schemaName: schemaRecord.schemaName,
            requestedAt,
            requestedBy: 'tenant-deprovision-workflow',
          },
        }),
      ],
    );

    schemaRecord.status = 'pending_deletion';
    schemaRecord.metadata = {
      ...(schemaRecord.metadata ?? {}),
      cleanupRunId,
      cleanupOperationId: proof.operationId,
      cleanupRequestedAt: requestedAt,
    };
    await this.tenantSchemaRepository.save(schemaRecord);
    this.logger.log(`Tenant schema cleanup for ${tenant.id} is queued for aqua-db-migrate`);
  }

  private serializeCleanupDropProof(proof: CleanupDropProof): Record<string, unknown> {
    return {
      operationId: proof.operationId,
      tenantId: proof.tenantId,
      purpose: proof.purpose,
      actorId: proof.actorId,
      approverId: proof.approverId,
      reason: proof.reason,
      legalHoldCheckedAt: proof.legalHoldCheckedAt,
      recoveryPoint: proof.recoveryPoint,
      preCounts: proof.preCounts,
      postCounts: proof.postCounts,
      createdAt: proof.createdAt,
    };
  }

  /**
   * Create first admin user for a tenant
   */
  private async createFirstAdminUser(
    tenantId: string,
    email: string,
    firstName: string,
    lastName: string,
    context: AuthProvisioningCommandContext,
  ): Promise<{
    success: boolean;
    userId?: string;
    error?: string;
  }> {
    try {
      const result = await this.authProvisioningClient.createTenantAdmin({
        ...this.buildAuthCommandMetadata('CreateFirstAdminInvite', tenantId, context, {
          email,
          firstName,
          lastName,
        }),
        email,
        firstName,
        lastName,
        invitedBy: context.actorId,
      });

      this.logger.log(
        `Created first admin user for tenant ${tenantId}: ${email} with TENANT_ADMIN permissions`,
      );

      return {
        success: true,
        userId: result.userId,
      };
    } catch (error) {
      this.logger.error(`Failed to create first admin: ${(error as Error).message}`);
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
    context: AuthProvisioningCommandContext,
  ): Promise<void> {
    if (moduleIds.length === 0) return;

    this.logger.log(`Assigning ${moduleIds.length} modules to tenant ${tenantId}`);

    try {
      await this.authProvisioningClient.assignTenantModules({
        ...this.buildAuthCommandMetadata('AssignModules', tenantId, context, { moduleIds }),
        moduleIds,
        assignedBy: context.actorId,
      });
    } catch (error) {
      throw new Error(
        `Could not assign modules to tenant ${tenantId}: ${(error as Error).message}`,
      );
    }
  }

  private async rollbackAuthProvisioning(
    tenantId: string,
    completedSteps: Array<'create_admin' | 'setup_roles' | 'assign_modules' | 'activate_tenant'>,
    reason: string,
    context: AuthProvisioningCommandContext,
  ): Promise<void> {
    try {
      await this.authProvisioningClient.rollbackTenantProvisioning({
        ...this.buildAuthCommandMetadata('RollbackProvisioning', tenantId, context, {
          completedSteps,
          reason,
        }),
        completedSteps,
        reason,
      });
    } catch (err) {
      this.logger.error(`Auth rollback failed for tenant ${tenantId}: ${(err as Error).message}`);
    }
  }

  private buildAuthCommandMetadata(
    commandType: string,
    tenantId: string,
    context: AuthProvisioningCommandContext,
    _payload: unknown,
  ): {
    operationId: string;
    tenantId: string;
    actor: { id: string; type: 'user' };
    requestReference: string;
    auditMetadata: Record<string, unknown>;
  } {
    return {
      operationId: context.operationId,
      tenantId,
      actor: { id: context.actorId, type: 'user' },
      requestReference: `${context.idempotencyKeyBase}:${commandType}`,
      auditMetadata: {
        source: 'admin-api-service',
        commandType,
        requestPayloadHash: context.requestPayloadHash,
      },
    };
  }

  private hashPayload(payload: unknown): string {
    return crypto.createHash('sha256').update(this.stableStringify(payload)).digest('hex');
  }

  private stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }

    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${this.stableStringify(record[key])}`)
        .join(',')}}`;
    }

    return JSON.stringify(value);
  }

  /**
   * Seed default water quality parameter configs for a new tenant.
   * Inserts a comprehensive set of common aquaculture parameters that
   * works for most species. Tenant admins can add, remove, or customize
   * parameters after provisioning via the Parameters tab.
   */
  private async seedDefaultWaterQualityParams(tenantId: string): Promise<void> {
    this.logger.log(`Seeding default water quality parameters for tenant ${tenantId}`);
    const schemaName = validateSqlIdentifier(getTenantSchemaName(tenantId), 'schema');

    // Common aquaculture parameters — covers freshwater + seawater basics
    const params = [
      {
        code: 'temperature',
        name: 'Temperature',
        unit: '°C',
        precision: 1,
        group: 'basic',
        optMin: 8,
        optMax: 20,
        warnMin: 4,
        warnMax: 24,
        critMin: 2,
        critMax: 28,
        color: '#3b82f6',
        order: 1,
        required: true,
        axis: 'left',
      },
      {
        code: 'dissolved_oxygen',
        name: 'Dissolved Oxygen',
        unit: 'mg/L',
        precision: 1,
        group: 'basic',
        optMin: 6,
        optMax: 12,
        warnMin: 4.5,
        warnMax: 14,
        critMin: 3,
        critMax: 16,
        color: '#22c55e',
        order: 2,
        required: true,
        axis: 'left',
      },
      {
        code: 'ph',
        name: 'pH',
        unit: '',
        precision: 2,
        group: 'basic',
        optMin: 6.5,
        optMax: 8.5,
        warnMin: 6.0,
        warnMax: 9.0,
        critMin: 5.5,
        critMax: 9.5,
        color: '#8b5cf6',
        order: 3,
        required: true,
        axis: 'left',
      },
      {
        code: 'ammonia',
        name: 'Ammonia (NH₃)',
        unit: 'mg/L',
        precision: 3,
        group: 'nitrogen_cycle',
        optMin: 0,
        optMax: 0.02,
        warnMin: 0,
        warnMax: 0.05,
        critMin: 0,
        critMax: 0.1,
        color: '#ef4444',
        order: 4,
        required: true,
        axis: 'right',
      },
      {
        code: 'nitrite',
        name: 'Nitrite (NO₂)',
        unit: 'mg/L',
        precision: 3,
        group: 'nitrogen_cycle',
        optMin: 0,
        optMax: 0.1,
        warnMin: 0,
        warnMax: 0.3,
        critMin: 0,
        critMax: 0.5,
        color: '#f97316',
        order: 5,
        required: true,
        axis: 'right',
      },
      {
        code: 'nitrate',
        name: 'Nitrate (NO₃)',
        unit: 'mg/L',
        precision: 1,
        group: 'nitrogen_cycle',
        optMin: 0,
        optMax: 50,
        warnMin: 0,
        warnMax: 80,
        critMin: 0,
        critMax: 100,
        color: '#eab308',
        order: 6,
        required: false,
        axis: 'right',
      },
      {
        code: 'salinity',
        name: 'Salinity',
        unit: 'ppt',
        precision: 1,
        group: 'basic',
        optMin: 0,
        optMax: 38,
        warnMin: 0,
        warnMax: 42,
        critMin: 0,
        critMax: 45,
        color: '#0891b2',
        order: 7,
        required: false,
        axis: 'left',
      },
      {
        code: 'alkalinity',
        name: 'Alkalinity',
        unit: 'mg/L CaCO₃',
        precision: 0,
        group: 'basic',
        optMin: 40,
        optMax: 200,
        warnMin: 20,
        warnMax: 300,
        critMin: 10,
        critMax: 400,
        color: '#a855f7',
        order: 8,
        required: false,
        axis: 'left',
      },
      {
        code: 'turbidity',
        name: 'Turbidity',
        unit: 'NTU',
        precision: 1,
        group: 'basic',
        optMin: 0,
        optMax: 10,
        warnMin: 0,
        warnMax: 25,
        critMin: 0,
        critMax: 50,
        color: '#78716c',
        order: 9,
        required: false,
        axis: 'left',
      },
      {
        code: 'co2',
        name: 'Carbon Dioxide',
        unit: 'mg/L',
        precision: 1,
        group: 'basic',
        optMin: 0,
        optMax: 15,
        warnMin: 0,
        warnMax: 25,
        critMin: 0,
        critMax: 40,
        color: '#06b6d4',
        order: 10,
        required: false,
        axis: 'right',
      },
      {
        code: 'oxygen_saturation',
        name: 'Oxygen Saturation',
        unit: '%',
        precision: 0,
        group: 'basic',
        optMin: 70,
        optMax: 120,
        warnMin: 50,
        warnMax: 130,
        critMin: 30,
        critMax: 150,
        color: '#16a34a',
        order: 11,
        required: false,
        axis: 'left',
      },
      {
        code: 'conductivity',
        name: 'Conductivity',
        unit: 'µS/cm',
        precision: 0,
        group: 'basic',
        optMin: 50,
        optMax: 800,
        warnMin: 20,
        warnMax: 1200,
        critMin: 10,
        critMax: 2000,
        color: '#14b8a6',
        order: 12,
        required: false,
        axis: 'right',
      },
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
          [
            tenantId,
            p.code,
            p.name,
            p.unit,
            p.precision,
            p.group,
            p.optMin,
            p.optMax,
            p.warnMin,
            p.warnMax,
            p.critMin,
            p.critMax,
            p.color,
            p.order,
            p.required,
            p.axis,
          ],
        );
      }

      this.logger.log(
        `Seeded ${params.length} default water quality parameters for tenant ${tenantId}`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to seed water quality params for tenant ${tenantId}: ${(error as Error).message}. ` +
          `Tenant can manually configure parameters via the Parameters tab.`,
      );
      // Non-fatal — tenant can still use the system, just needs to set up params manually
    }
  }
}
