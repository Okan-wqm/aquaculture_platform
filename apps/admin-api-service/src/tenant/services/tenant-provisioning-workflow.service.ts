import * as crypto from 'crypto';

import { applyTenantRlsToSchema } from '@aquaculture/backend-common/database';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  AUTH_ADMIN_COMMAND_SUBJECTS,
  createBaseEvent,
  TenantCreatedEvent,
  type AdminSetTenantStatusCommand,
  type AdminSetTenantStatusResult,
  type BaseEvent,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, EntityManager } from 'typeorm';

import { AuditLogService } from '../../audit/audit.service';
import { BillingCycle, PlanTier } from '../../billing/entities/plan-definition.entity';
import { ModuleAssignmentService } from '../../modules/tenant-management/services/module-assignment.service';
import { AuthCommandClientService } from '../../auth/auth-command-client.service';
import { MessagingCommandClientService } from '../../messaging/messaging-command-client.service';
import {
  CreateTenantAcceptedResponse,
  CreateTenantDto,
  TenantProvisioningState,
  TenantProvisioningStepDto,
} from '../dto/tenant.dto';
import { Tenant, TenantPlan, TenantSettings, TenantStatus } from '../entities/tenant.entity';

import { TenantProvisioningService } from './tenant-provisioning.service';

interface TenantProvisioningRunRow {
  id: string;
  tenantId: string;
  idempotencyKey: string;
  requestHash: string;
  requestPayload: unknown;
  actorUserId: string;
  state: TenantProvisioningState;
  currentStep: string | null;
  lastError: string | null;
  attempts: number;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface TenantProvisioningStepRow {
  stepName: string;
  state: TenantProvisioningState;
  attempts: number;
  lastError: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

interface TenantReadRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  settings: TenantSettings | null;
  customDomain: string | null;
  description: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface IdRow {
  id: string;
}

const MAX_OPERATION_ATTEMPTS = 3;
const DEFAULT_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class TenantProvisioningWorkflowService {
  private readonly logger = new Logger(TenantProvisioningWorkflowService.name);
  private processingQueue = false;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly auditLogService: AuditLogService,
    private readonly provisioningService: TenantProvisioningService,
    private readonly moduleAssignmentService: ModuleAssignmentService,
    private readonly authCommandClient: AuthCommandClientService,
    private readonly messagingCommandClient: MessagingCommandClientService,
  ) {}

  async createTenantOperation(
    data: CreateTenantDto,
    actorUserId: string,
    idempotencyKey?: string,
  ): Promise<CreateTenantAcceptedResponse> {
    const payload = this.normalizeCreatePayload(data);
    const normalizedKey = this.normalizeIdempotencyKey(idempotencyKey);
    const requestHash = this.hashPayload(payload);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      const existingRows = await this.managerRows<TenantProvisioningRunRow>(
        queryRunner.manager,
        `SELECT id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
                "actorUserId", state, "currentStep", "lastError", attempts,
                "startedAt", "completedAt", "createdAt", "updatedAt"
           FROM admin.tenant_provisioning_runs
          WHERE "actorUserId" = $1 AND "idempotencyKey" = $2
          FOR UPDATE`,
        [actorUserId, normalizedKey],
      );

      const existingRun = existingRows[0];
      if (existingRun) {
        if (existingRun.requestHash !== requestHash) {
          throw new ConflictException(
            'Idempotency-Key was already used for a different tenant creation request',
          );
        }

        const existingTenant = await queryRunner.manager.findOne(Tenant, {
          where: { id: existingRun.tenantId },
        });
        await queryRunner.commitTransaction();
        return this.toAcceptedResponse(existingRun, existingTenant ?? undefined);
      }

      await this.assertNoDuplicateTenant(queryRunner.manager, payload);

      const tenant = queryRunner.manager.create(Tenant, this.toTenantEntity(payload, actorUserId));
      const savedTenant = await queryRunner.manager.save(tenant);

      const runRows = await this.managerRows<TenantProvisioningRunRow>(
        queryRunner.manager,
        `INSERT INTO admin.tenant_provisioning_runs (
             id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
             "actorUserId", state, attempts, "createdAt", "updatedAt"
           ) VALUES (
             uuid_generate_v4(), $1, $2, $3, $4::jsonb, $5, $6, 0, now(), now()
           )
           RETURNING id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
                     "actorUserId", state, "currentStep", "lastError", attempts,
                     "startedAt", "completedAt", "createdAt", "updatedAt"`,
        [
          savedTenant.id,
          normalizedKey,
          requestHash,
          JSON.stringify(payload),
          actorUserId,
          TenantProvisioningState.QUEUED,
        ],
      );

      const run = runRows[0];
      if (!run) {
        throw new Error('Tenant provisioning operation was not created');
      }

      await queryRunner.commitTransaction();
      return this.toAcceptedResponse(run, this.hydrateCreatedTenant(savedTenant, payload));
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async getOperation(operationId: string): Promise<CreateTenantAcceptedResponse> {
    const run = await this.getRun(operationId);
    if (!run) {
      throw new NotFoundException(`Tenant provisioning operation '${operationId}' not found`);
    }

    const tenant = await this.findTenantById(run.tenantId);
    const steps = await this.getRunSteps(operationId);
    return this.toAcceptedResponse(run, tenant ?? undefined, steps);
  }

  async getLatestTenantOperation(tenantId: string): Promise<CreateTenantAcceptedResponse | null> {
    const rows = await this.queryRows<TenantProvisioningRunRow>(
      `SELECT id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
              "actorUserId", state, "currentStep", "lastError", attempts,
              "startedAt", "completedAt", "createdAt", "updatedAt"
         FROM admin.tenant_provisioning_runs
        WHERE "tenantId" = $1
        ORDER BY "createdAt" DESC
        LIMIT 1`,
      [tenantId],
    );

    const run = rows[0];
    if (!run) return null;

    const tenant = await this.findTenantById(tenantId);
    const steps = await this.getRunSteps(run.id);
    return this.toAcceptedResponse(run, tenant ?? undefined, steps);
  }

  async retryOperation(operationId: string): Promise<CreateTenantAcceptedResponse> {
    const rows = await this.queryRows<TenantProvisioningRunRow>(
      `UPDATE admin.tenant_provisioning_runs
          SET state = $2,
              "currentStep" = NULL,
              "lastError" = NULL,
              "nextRetryAt" = NULL,
              "completedAt" = NULL,
              "updatedAt" = now()
        WHERE id = $1 AND state = $3
        RETURNING id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
                  "actorUserId", state, "currentStep", "lastError", attempts,
                  "startedAt", "completedAt", "createdAt", "updatedAt"`,
      [operationId, TenantProvisioningState.QUEUED, TenantProvisioningState.FAILED],
    );

    const run = rows[0];
    if (!run) {
      throw new ConflictException('Only failed tenant provisioning operations can be retried');
    }

    this.processOperation(operationId).catch((error: Error) => {
      this.logger.error(`Retry processing failed for operation ${operationId}: ${error.message}`);
    });

    return this.getOperation(operationId);
  }

  async processOperation(operationId: string): Promise<void> {
    const run = await this.claimRun(operationId);
    if (!run) return;

    try {
      const payload = this.parseCreatePayload(run.requestPayload);
      const tenant = await this.findTenantById(run.tenantId);

      if (!tenant) {
        throw new NotFoundException(`Tenant '${run.tenantId}' not found for provisioning operation`);
      }

      await this.runStep(run.id, 'audit_create_requested', async () => {
        await this.auditLogService.log({
          action: 'TENANT_CREATE_REQUESTED',
          entityType: 'tenant',
          entityId: tenant.id,
          performedBy: run.actorUserId,
          details: {
            operationId: run.id,
            name: tenant.name,
            slug: tenant.slug,
            moduleIds: payload.moduleIds,
          },
        });
      });

      await this.runStep(run.id, 'publish_tenant_created', async () => {
        const event: TenantCreatedEvent = {
          ...createBaseEvent<TenantCreatedEvent>('TenantCreated', tenant.id, {
            aggregateId: tenant.id,
            aggregateType: 'Tenant',
          }),
          slug: tenant.slug,
          name: tenant.name,
        };
        await this.enqueueEvent(event, 'tenant-created:' + run.id);
      });

      await this.runStep(run.id, 'assign_modules', async () => {
        await this.assignModulesWithPricing(tenant, payload, run.actorUserId);
      });

      await this.runStep(run.id, 'provision_resources', async () => {
        const adminEmail = payload.primaryContact?.email ?? payload.contactEmail;
        const result = await this.provisioningService.provisionTenant(tenant.id, {
          createFirstAdmin: adminEmail !== undefined,
          adminEmail,
          adminFirstName: this.getFirstName(payload.primaryContact?.name),
          adminLastName: this.getLastName(payload.primaryContact?.name),
        });

        if (!result.success) {
          throw new Error(result.error ?? 'Tenant resource provisioning failed');
        }
      });

      await this.runStep(run.id, 'ensure_messaging_partitions', async () => {
        await this.messagingCommandClient.ensureTenantPartitions(tenant.id, run.id);
      });

      await this.runStep(run.id, 'apply_runtime_rls', async () => {
        await this.applyTenantRls(tenant.id);
      });

      await this.runStep(run.id, 'create_subscription', async () => {
        await this.createTenantSubscription(tenant, payload, run.actorUserId);
      });

      await this.runStep(run.id, 'audit_provisioned', async () => {
        await this.auditLogService.log({
          action: 'TENANT_PROVISIONED',
          entityType: 'tenant',
          entityId: tenant.id,
          performedBy: run.actorUserId,
          details: {
            operationId: run.id,
            moduleIds: payload.moduleIds,
          },
        });
      });

      await this.markRunSucceeded(run.id);
      this.logger.log(`Tenant provisioning operation ${run.id} completed for tenant ${tenant.id}`);
    } catch (error) {
      await this.markRunFailed(run.id, error);
      await this.publishFailure(run, error);
    }
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async processQueuedOperations(): Promise<void> {
    if (this.processingQueue) return;
    this.processingQueue = true;

    try {
      await this.requeueStaleRuns();
      const rows = await this.queryRows<IdRow>(
        `SELECT id
           FROM admin.tenant_provisioning_runs
          WHERE state = $1
            AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= now())
          ORDER BY "createdAt" ASC
          LIMIT 3`,
        [TenantProvisioningState.QUEUED],
      );

      for (const row of rows) {
        await this.processOperation(row.id);
      }
    } catch (error) {
      this.logger.error(
        `Tenant provisioning queue sweep failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
    } finally {
      this.processingQueue = false;
    }
  }

  private normalizeCreatePayload(data: CreateTenantDto): CreateTenantDto {
    const moduleIds = Array.from(new Set(data.moduleIds ?? []));
    if (moduleIds.length === 0) {
      throw new BadRequestException('At least one module must be selected for tenant provisioning');
    }

    const slug = data.slug?.trim().toLowerCase() || this.slugify(data.name);

    return {
      ...data,
      name: data.name.trim(),
      slug,
      description: data.description?.trim(),
      domain: data.domain?.trim().toLowerCase(),
      country: data.country?.trim().toUpperCase(),
      region: data.region?.trim(),
      moduleIds,
      moduleQuantities: data.moduleQuantities?.filter((q) => moduleIds.includes(q.moduleId)),
      billingEmail: data.billingEmail?.trim().toLowerCase(),
      contactEmail: data.contactEmail?.trim().toLowerCase(),
      contactPhone: data.contactPhone?.trim(),
      billingCycle: data.billingCycle ?? 'monthly',
    };
  }

  private slugify(value: string): string {
    const slug = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
      .replace(/-+$/g, '');

    if (slug.length < 3) {
      throw new BadRequestException('Tenant name cannot produce a valid slug');
    }

    return slug;
  }

  private normalizeIdempotencyKey(idempotencyKey?: string): string {
    const trimmed = idempotencyKey?.trim();
    if (trimmed && trimmed.length <= 128) return trimmed;

    const bucket = Math.floor(Date.now() / DEFAULT_IDEMPOTENCY_TTL_MS);
    return crypto.createHash('sha256').update(`tenant-create:${bucket}:${crypto.randomUUID()}`).digest('hex');
  }

  private hashPayload(payload: CreateTenantDto): string {
    return crypto.createHash('sha256').update(this.stableStringify(payload)).digest('hex');
  }

  private stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }

    if (this.isRecord(value)) {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${this.stableStringify(value[key])}`).join(',')}}`;
    }

    return JSON.stringify(value);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private async assertNoDuplicateTenant(
    manager: EntityManager,
    data: CreateTenantDto,
  ): Promise<void> {
    if (data.slug) {
      const existingBySlug = await manager.findOne(Tenant, {
        where: { slug: data.slug },
        lock: { mode: 'pessimistic_read' },
      });

      if (existingBySlug) {
        throw new ConflictException(`Tenant with slug '${data.slug}' already exists`);
      }
    }

    if (data.domain) {
      const existingByDomain = await manager.findOne(Tenant, {
        where: { customDomain: data.domain },
        lock: { mode: 'pessimistic_read' },
      });

      if (existingByDomain) {
        throw new ConflictException(`Tenant with domain '${data.domain}' already exists`);
      }
    }
  }

  private toTenantEntity(data: CreateTenantDto, actorUserId: string): Partial<Tenant> {
    const settings = this.buildTenantSettings(data);
    const primaryContact = data.primaryContact;

    return {
      name: data.name,
      slug: data.slug,
      description: data.description,
      customDomain: data.domain,
      contactEmail: data.contactEmail ?? primaryContact?.email ?? data.billingEmail,
      contactPhone: data.contactPhone ?? primaryContact?.phone,
      plan: data.plan ?? data.tier ?? TenantPlan.STARTER,
      status: TenantStatus.PENDING,
      settings,
      maxUsers: data.maxUsers ?? data.limits?.maxUsers ?? 5,
      maxStorage: data.maxStorage ?? data.limits?.storageGb ?? -1,
      isTrialActive: (data.trialDays ?? 0) > 0,
      trialEndsAt: this.getTrialEndsAt(data.trialDays),
      createdBy: actorUserId,
      userCount: 0,
      farmCount: 0,
      sensorCount: 0,
    };
  }

  private buildTenantSettings(data: CreateTenantDto): TenantSettings {
    const notificationPreferences = data.settings?.notificationPreferences
      ? {
          email: data.settings.notificationPreferences.email ?? true,
          sms: data.settings.notificationPreferences.sms ?? false,
          push: data.settings.notificationPreferences.push ?? true,
          slack: data.settings.notificationPreferences.slack ?? false,
        }
      : undefined;

    return {
      ...(data.settings ?? {}),
      notificationPreferences,
      country: data.country,
      region: data.region,
      billingEmail: data.billingEmail ?? data.primaryContact?.email,
      primaryContact: data.primaryContact
        ? {
            name: data.primaryContact.name,
            email: data.primaryContact.email,
            phone: data.primaryContact.phone,
            role: data.primaryContact.role ?? 'Admin',
          }
        : undefined,
      billingContact: data.billingContact
        ? {
            name: data.billingContact.name,
            email: data.billingContact.email,
            phone: data.billingContact.phone,
            role: data.billingContact.role ?? 'Billing Contact',
          }
        : undefined,
    };
  }

  private hydrateCreatedTenant(tenant: Tenant, payload: CreateTenantDto): Tenant {
    tenant.domain = tenant.customDomain;
    tenant.country = payload.country;
    tenant.region = payload.region;
    tenant.billingEmail = payload.billingEmail ?? payload.primaryContact?.email;
    tenant.primaryContact = payload.primaryContact
      ? {
          name: payload.primaryContact.name,
          email: payload.primaryContact.email,
          phone: payload.primaryContact.phone,
          role: payload.primaryContact.role ?? 'Admin',
        }
      : undefined;
    tenant.billingContact = payload.billingContact
      ? {
          name: payload.billingContact.name,
          email: payload.billingContact.email,
          phone: payload.billingContact.phone,
          role: payload.billingContact.role ?? 'Billing Contact',
        }
      : undefined;
    return tenant;
  }

  private async findTenantById(tenantId: string): Promise<Tenant | undefined> {
    const rows = await this.queryRows<TenantReadRow>(
      `SELECT id, name, slug, status, plan, settings,
              "customDomain", description, "contactEmail", "contactPhone",
              "createdBy", "createdAt", "updatedAt"
         FROM auth.tenants
        WHERE id = $1
        LIMIT 1`,
      [tenantId],
    );
    const row = rows[0];
    if (!row) return undefined;

    const tenant: Tenant = Object.assign(new Tenant(), {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      plan: row.plan,
      settings: row.settings ?? undefined,
      customDomain: row.customDomain ?? undefined,
      description: row.description ?? undefined,
      contactEmail: row.contactEmail ?? undefined,
      contactPhone: row.contactPhone ?? undefined,
      createdBy: row.createdBy ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    tenant.hydrateCompatibilityFields();
    return tenant;
  }

  private getTrialEndsAt(trialDays?: number): Date | undefined {
    if (!trialDays || trialDays <= 0) return undefined;
    return new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);
  }

  private async assignModulesWithPricing(
    tenant: Tenant,
    data: CreateTenantDto,
    assignedBy: string,
  ): Promise<void> {
    const moduleIds = data.moduleIds ?? [];
    if (moduleIds.length === 0) {
      throw new BadRequestException('At least one module must be selected for tenant provisioning');
    }

    const modules = moduleIds.map((moduleId) => {
      const quantityConfig = data.moduleQuantities?.find((q) => q.moduleId === moduleId);
      return {
        moduleId,
        quantities: quantityConfig
          ? {
              users: quantityConfig.users,
              farms: quantityConfig.farms,
              ponds: quantityConfig.ponds,
              sensors: quantityConfig.sensors,
              employees: quantityConfig.employees,
              storageGb: quantityConfig.storageGb,
              apiCalls: quantityConfig.apiCalls,
              alerts: quantityConfig.alerts,
              reports: quantityConfig.reports,
              integrations: quantityConfig.integrations,
              devices: quantityConfig.devices,
            }
          : {
              users: 5,
              farms: 1,
              ponds: 10,
              sensors: 5,
            },
      };
    });

    const result = await this.moduleAssignmentService.assignModulesToTenant({
      tenantId: tenant.id,
      modules,
      assignedBy,
      tier: this.toPlanTier(tenant.tier),
      billingCycle: this.toBillingCycle(data.billingCycle),
    });

    if (!result.success) {
      throw new Error(
        `Module assignment failed: ${result.failedModules.map((f) => `${f.moduleId}:${f.error}`).join(', ')}`,
      );
    }
  }

  private async createTenantSubscription(
    tenant: Tenant,
    data: CreateTenantDto,
    createdBy: string,
  ): Promise<void> {
    await this.enqueueEvent({
      ...createBaseEvent('TenantSubscriptionRequested', tenant.id, {
        aggregateId: tenant.id,
        aggregateType: 'Tenant',
      }),
      tenantName: tenant.name,
      moduleIds: data.moduleIds,
      moduleQuantities: data.moduleQuantities,
      trialDays: data.trialDays,
      tier: this.toPlanTier(tenant.tier),
      billingCycle: data.billingCycle ?? 'monthly',
      billingEmail: data.billingEmail ?? data.primaryContact?.email,
      createdBy,
    }, 'tenant-subscription:' + tenant.id);
  }

  private async enqueueEvent<TEvent extends BaseEvent>(
    event: TEvent,
    idempotencyKey: string,
  ): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await this.outboxPublisher.enqueue(event, queryRunner.manager, {
        aggregateId: event.aggregateId,
        idempotencyKey,
      });
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private toPlanTier(value: string | undefined): PlanTier {
    const tierMap: Record<string, PlanTier> = {
      starter: PlanTier.STARTER,
      professional: PlanTier.PROFESSIONAL,
      enterprise: PlanTier.ENTERPRISE,
    };
    return tierMap[value?.toLowerCase() ?? 'starter'] ?? PlanTier.STARTER;
  }

  private toBillingCycle(value: CreateTenantDto['billingCycle']): BillingCycle {
    const cycleMap: Record<string, BillingCycle> = {
      monthly: BillingCycle.MONTHLY,
      quarterly: BillingCycle.QUARTERLY,
      semi_annual: BillingCycle.SEMI_ANNUAL,
      annual: BillingCycle.ANNUAL,
    };
    return cycleMap[value ?? 'monthly'] ?? BillingCycle.MONTHLY;
  }

  private getFirstName(fullName?: string): string {
    return fullName?.trim().split(/\s+/)[0] || 'Admin';
  }

  private getLastName(fullName?: string): string {
    const parts = fullName?.trim().split(/\s+/).slice(1) ?? [];
    return parts.length > 0 ? parts.join(' ') : 'User';
  }

  private async applyTenantRls(tenantId: string): Promise<void> {
    const schemaRows = await this.queryRows<{ schemaName: string }>(
      `SELECT "schemaName"
         FROM admin.tenant_schemas
        WHERE "tenantId" = $1 AND status = 'active'
        ORDER BY "updatedAt" DESC
        LIMIT 1`,
      [tenantId],
    );
    const schemaName = schemaRows[0]?.schemaName;
    if (!schemaName) {
      throw new Error(`Active tenant schema tracking record missing for tenant ${tenantId}`);
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await applyTenantRlsToSchema(queryRunner, {
        schemaOverride: schemaName,
        logger: this.logger,
      });
    } finally {
      await queryRunner.release();
    }
  }

  private parseCreatePayload(value: unknown): CreateTenantDto {
    if (!this.isRecord(value)) {
      throw new Error('Provisioning operation payload is not an object');
    }

    const name = typeof value.name === 'string' ? value.name : undefined;
    const moduleIds = Array.isArray(value.moduleIds)
      ? value.moduleIds.filter((item): item is string => typeof item === 'string')
      : [];

    if (!name || moduleIds.length === 0) {
      throw new Error('Provisioning operation payload is missing tenant name or module IDs');
    }

    return value as unknown as CreateTenantDto;
  }

  private async claimRun(operationId: string): Promise<TenantProvisioningRunRow | null> {
    const rows = await this.queryRows<TenantProvisioningRunRow>(
      `UPDATE admin.tenant_provisioning_runs
          SET state = $2,
              attempts = attempts + 1,
              "startedAt" = COALESCE("startedAt", now()),
              "completedAt" = NULL,
              "updatedAt" = now()
        WHERE id = $1
          AND state = $3
          AND attempts < $4
          AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= now())
        RETURNING id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
                  "actorUserId", state, "currentStep", "lastError", attempts,
                  "startedAt", "completedAt", "createdAt", "updatedAt"`,
      [
        operationId,
        TenantProvisioningState.RUNNING,
        TenantProvisioningState.QUEUED,
        MAX_OPERATION_ATTEMPTS,
      ],
    );
    return rows[0] ?? null;
  }

  private async runStep(
    runId: string,
    stepName: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const existingRows = await this.queryRows<TenantProvisioningStepRow>(
      `SELECT "stepName", state, attempts, "lastError", "startedAt", "completedAt"
         FROM admin.tenant_provisioning_steps
        WHERE "runId" = $1 AND "stepName" = $2
        LIMIT 1`,
      [runId, stepName],
    );

    if (existingRows[0]?.state === TenantProvisioningState.SUCCEEDED) {
      return;
    }

    await this.queryRows<TenantProvisioningStepRow>(
      `INSERT INTO admin.tenant_provisioning_steps (
          id, "runId", "stepName", state, attempts, "startedAt", "createdAt", "updatedAt"
        ) VALUES (
          uuid_generate_v4(), $1, $2, $3, 1, now(), now(), now()
        )
        ON CONFLICT ("runId", "stepName")
        DO UPDATE SET
          state = $3,
          attempts = admin.tenant_provisioning_steps.attempts + 1,
          "startedAt" = now(),
          "completedAt" = NULL,
          "lastError" = NULL,
          "updatedAt" = now()
        RETURNING "stepName", state, attempts, "lastError", "startedAt", "completedAt"`,
      [runId, stepName, TenantProvisioningState.RUNNING],
    );

    await this.queryRows<TenantProvisioningRunRow>(
      `UPDATE admin.tenant_provisioning_runs
          SET "currentStep" = $2,
              "updatedAt" = now()
        WHERE id = $1
        RETURNING id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
                  "actorUserId", state, "currentStep", "lastError", attempts,
                  "startedAt", "completedAt", "createdAt", "updatedAt"`,
      [runId, stepName],
    );

    try {
      await work();
      await this.queryRows<TenantProvisioningStepRow>(
        `UPDATE admin.tenant_provisioning_steps
            SET state = $3,
                "completedAt" = now(),
                "lastError" = NULL,
                "updatedAt" = now()
          WHERE "runId" = $1 AND "stepName" = $2
          RETURNING "stepName", state, attempts, "lastError", "startedAt", "completedAt"`,
        [runId, stepName, TenantProvisioningState.SUCCEEDED],
      );
    } catch (error) {
      await this.queryRows<TenantProvisioningStepRow>(
        `UPDATE admin.tenant_provisioning_steps
            SET state = $3,
                "completedAt" = now(),
                "lastError" = $4,
                "updatedAt" = now()
          WHERE "runId" = $1 AND "stepName" = $2
          RETURNING "stepName", state, attempts, "lastError", "startedAt", "completedAt"`,
        [runId, stepName, TenantProvisioningState.FAILED, this.errorMessage(error)],
      );
      throw error;
    }
  }

  private async markRunSucceeded(runId: string): Promise<void> {
    await this.queryRows<TenantProvisioningRunRow>(
      `UPDATE admin.tenant_provisioning_runs
          SET state = $2,
              "currentStep" = NULL,
              "lastError" = NULL,
              "completedAt" = now(),
              "updatedAt" = now()
        WHERE id = $1
        RETURNING id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
                  "actorUserId", state, "currentStep", "lastError", attempts,
                  "startedAt", "completedAt", "createdAt", "updatedAt"`,
      [runId, TenantProvisioningState.SUCCEEDED],
    );
  }

  private async markRunFailed(runId: string, error: unknown): Promise<void> {
    const run = await this.getRun(runId);
    if (run) {
      const tenantRows = await this.queryRows<{ status: string }>(
        `SELECT status FROM auth.tenants WHERE id = $1`,
        [run.tenantId],
      );
      if (tenantRows[0]?.status !== TenantStatus.ACTIVE) {
        const result = await this.authCommandClient.request<
          AdminSetTenantStatusCommand,
          AdminSetTenantStatusResult
        >(AUTH_ADMIN_COMMAND_SUBJECTS.SET_TENANT_STATUS, {
          tenantId: run.tenantId,
          status: TenantStatus.PROVISIONING_FAILED,
        });
        if (!result.success && result.errorCode !== 'INVALID_STATUS') {
          this.authCommandClient.assertSuccess(result, `Could not mark tenant ${run.tenantId} failed`);
        }
      }
    }

    await this.queryRows<TenantProvisioningRunRow>(
      `UPDATE admin.tenant_provisioning_runs
          SET state = $2,
              "lastError" = $3,
              "completedAt" = now(),
              "updatedAt" = now()
        WHERE id = $1
        RETURNING id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
                  "actorUserId", state, "currentStep", "lastError", attempts,
                  "startedAt", "completedAt", "createdAt", "updatedAt"`,
      [runId, TenantProvisioningState.FAILED, this.errorMessage(error)],
    );
  }

  private async publishFailure(run: TenantProvisioningRunRow, error: unknown): Promise<void> {
    const message = this.errorMessage(error);
    this.logger.error(`Tenant provisioning operation ${run.id} failed: ${message}`);

    await this.enqueueEvent({
      ...createBaseEvent('TenantProvisioningFailed', run.tenantId, {
        aggregateId: run.tenantId,
        aggregateType: 'Tenant',
        version: 4,
      }),
      operationId: run.id,
      error: message,
      currentStep: run.currentStep ?? undefined,
      attempt: run.attempts,
    }, 'tenant-provisioning-failed:' + run.id + ':' + run.attempts);
  }

  private async requeueStaleRuns(): Promise<void> {
    await this.queryRows<TenantProvisioningRunRow>(
      `UPDATE admin.tenant_provisioning_runs
          SET state = $2,
              "lastError" = 'Operation recovered after worker interruption',
              "updatedAt" = now()
        WHERE state = $1
          AND "updatedAt" < now() - interval '30 minutes'
          AND attempts < $3
        RETURNING id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
                  "actorUserId", state, "currentStep", "lastError", attempts,
                  "startedAt", "completedAt", "createdAt", "updatedAt"`,
      [TenantProvisioningState.RUNNING, TenantProvisioningState.QUEUED, MAX_OPERATION_ATTEMPTS],
    );
  }

  private async getRun(operationId: string): Promise<TenantProvisioningRunRow | null> {
    const rows = await this.queryRows<TenantProvisioningRunRow>(
      `SELECT id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
              "actorUserId", state, "currentStep", "lastError", attempts,
              "startedAt", "completedAt", "createdAt", "updatedAt"
         FROM admin.tenant_provisioning_runs
        WHERE id = $1`,
      [operationId],
    );
    return rows[0] ?? null;
  }

  private async getRunSteps(operationId: string): Promise<TenantProvisioningStepDto[]> {
    const rows = await this.queryRows<TenantProvisioningStepRow>(
      `SELECT "stepName", state, attempts, "lastError", "startedAt", "completedAt"
         FROM admin.tenant_provisioning_steps
        WHERE "runId" = $1
        ORDER BY "createdAt" ASC`,
      [operationId],
    );

    return rows.map((row) => ({
      name: row.stepName,
      state: row.state,
      attempts: row.attempts,
      lastError: row.lastError ?? undefined,
      startedAt: row.startedAt ?? undefined,
      completedAt: row.completedAt ?? undefined,
    }));
  }

  private toAcceptedResponse(
    run: TenantProvisioningRunRow,
    tenant?: Tenant,
    steps?: TenantProvisioningStepDto[],
  ): CreateTenantAcceptedResponse {
    return {
      accepted: true,
      id: tenant?.id ?? run.tenantId,
      tenantId: run.tenantId,
      operationId: run.id,
      provisioningState: run.state,
      statusUrl: `/api/v1/tenants/provisioning/${run.id}`,
      status: tenant?.status ?? TenantStatus.PENDING,
      name: tenant?.name ?? '',
      slug: tenant?.slug ?? '',
      tier: tenant?.tier ?? TenantPlan.STARTER,
      currentStep: run.currentStep ?? undefined,
      error: run.lastError ?? undefined,
      steps,
    };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async queryRows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const rows: unknown = await this.dataSource.query(sql, params);
    return Array.isArray(rows) ? (rows as T[]) : [];
  }

  private async managerRows<T>(
    manager: EntityManager,
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const rows: unknown = await manager.query(sql, params);
    return Array.isArray(rows) ? (rows as T[]) : [];
  }
}
