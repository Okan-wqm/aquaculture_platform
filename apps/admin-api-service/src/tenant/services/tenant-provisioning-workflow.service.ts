import * as crypto from 'crypto';

import { getTenantSchemaName, queryRowsNormalized } from '@aquaculture/backend-common/database';
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
  createBaseEvent,
  TENANT_ONBOARDING_WORKFLOW_V1,
  type BaseEvent,
  type BillingCycle as BillingCommandBillingCycle,
  type PlanTier as BillingCommandPlanTier,
  type TenantOnboardingRequestedEvent,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, EntityManager } from 'typeorm';

import { AuditLogService } from '../../audit/audit.service';
import {
  BillingCycle as ModuleBillingCycle,
  PlanTier as ModulePlanTier,
} from '../../billing/entities/plan-definition.entity';
import { BillingAdminCommandClientService } from '../../billing/services/billing-admin-command-client.service';
import {
  ModuleAssignmentService,
  type ModuleQuantities,
} from '../../modules/tenant-management/services/module-assignment.service';
import {
  CreateTenantAcceptedResponse,
  CreateTenantDto,
  TenantProvisioningState,
  TenantProvisioningStepDto,
} from '../dto/tenant.dto';
import { Tenant, TenantPlan, TenantSettings, TenantStatus } from '../entities/tenant.entity';

import { AuthTenantProvisioningClientService } from './auth-tenant-provisioning-client.service';
import { TenantProvisioningMetricsService } from './tenant-provisioning-metrics.service';
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
  onboardingAttempt?: number;
  onboardingRequestEventId?: string | null;
  onboardingRequestedAt?: Date | null;
  nextRetryAt?: Date | null;
  leaseToken?: string | null;
  leasedBy?: string | null;
  heartbeatAt?: Date | null;
  leaseExpiresAt?: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface TenantProvisioningStepRow {
  stepName: string;
  state: TenantProvisioningState;
  stepOrder?: number;
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
const OPERATION_LEASE_MS = 30 * 60 * 1000;
const DB_MIGRATE_PROVISIONER_RETRY_MS = 30 * 1000;
const ONBOARDING_ACK_RETRY_MS = 15 * 1000;

const PROVISIONING_STEPS = [
  'reserve_auth_tenant',
  'begin_provisioning',
  'audit_create_requested',
  'assign_modules',
  'publish_provisioning_requested',
  'wait_for_db_migrate_provisioner',
  'provision_application_resources',
  'publish_onboarding_requested',
  'wait_for_onboarding_ack',
  'create_subscription',
  'activate_tenant',
  'audit_provisioned',
  'publish_tenant_provisioned',
] as const;

type ProvisioningStepName = (typeof PROVISIONING_STEPS)[number];

class ProvisioningWaitPendingError extends Error {
  constructor(
    readonly stepName: ProvisioningStepName,
    readonly retryMs: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProvisioningWaitPendingError';
  }
}

const PROVISIONING_STEP_SELECT_SQL = `SELECT "stepName", state, "stepOrder", attempts, "lastError", "startedAt", "completedAt"
     FROM admin.tenant_provisioning_steps
    WHERE "runId" = $1
    ORDER BY "stepOrder" ASC, "createdAt" ASC`;

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
    private readonly authProvisioningClient: AuthTenantProvisioningClientService,
    private readonly billingCommandClient: BillingAdminCommandClientService,
    private readonly metrics: TenantProvisioningMetricsService,
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
                "onboardingAttempt", "onboardingRequestEventId", "onboardingRequestedAt",
                "nextRetryAt", "leaseToken", "leasedBy", "heartbeatAt", "leaseExpiresAt",
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
        const existingPayload = this.parseCreatePayload(existingRun.requestPayload);
        const responseTenant = existingTenant
          ? this.hydrateCreatedTenant(existingTenant, existingPayload)
          : this.createTenantDraft(existingRun.tenantId, existingPayload, existingRun.actorUserId);
        // A replayed POST is a progress query in disguise: return the same step
        // detail a poll would, so the caller sees where the run actually is.
        const existingSteps = await this.getRunStepsInTransaction(
          queryRunner.manager,
          existingRun.id,
        );
        await queryRunner.commitTransaction();
        return this.toAcceptedResponse(existingRun, responseTenant, existingSteps);
      }

      await this.assertNoDuplicateTenant(queryRunner.manager, payload);

      const tenantId = crypto.randomUUID();
      const operationId = crypto.randomUUID();
      const tenantDraft = queryRunner.manager.create(Tenant, {
        ...this.toTenantEntity(payload, actorUserId),
        id: tenantId,
      });

      const runRows = await this.managerRows<TenantProvisioningRunRow>(
        queryRunner.manager,
        `INSERT INTO admin.tenant_provisioning_runs (
             id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
             "actorUserId", state, attempts, "createdAt", "updatedAt"
           ) VALUES (
             $7, $1, $2, $3, $4::jsonb, $5, $6, 0, now(), now()
           )
           RETURNING id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
                     "actorUserId", state, "currentStep", "lastError", attempts,
                     "nextRetryAt", "leaseToken", "leasedBy", "heartbeatAt", "leaseExpiresAt",
                     "startedAt", "completedAt", "createdAt", "updatedAt"`,
        [
          tenantId,
          normalizedKey,
          requestHash,
          JSON.stringify(payload),
          actorUserId,
          TenantProvisioningState.QUEUED,
          operationId,
        ],
      );

      const run = runRows[0];
      if (!run) {
        throw new Error('Tenant provisioning operation was not created');
      }

      await this.seedProvisioningSteps(queryRunner.manager, run.id);
      const seededSteps = await this.getRunStepsInTransaction(queryRunner.manager, run.id);

      await queryRunner.commitTransaction();
      return this.toAcceptedResponse(
        run,
        this.hydrateCreatedTenant(tenantDraft, payload),
        seededSteps,
      );
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
              "nextRetryAt", "leaseToken", "leasedBy", "heartbeatAt", "leaseExpiresAt",
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
    let shouldProcess = false;
    await this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const lockedRows = await this.managerRows<TenantProvisioningRunRow>(
        manager,
        `SELECT id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
                "actorUserId", state, "currentStep", "lastError", attempts,
                "nextRetryAt", "leaseToken", "leasedBy", "heartbeatAt", "leaseExpiresAt",
                "startedAt", "completedAt", "createdAt", "updatedAt"
           FROM admin.tenant_provisioning_runs
          WHERE id = $1
          FOR UPDATE`,
        [operationId],
      );
      const current = lockedRows[0];
      if (!current) {
        throw new NotFoundException(`Tenant provisioning operation '${operationId}' not found`);
      }

      if (
        current.state === TenantProvisioningState.QUEUED ||
        current.state === TenantProvisioningState.RESERVING ||
        current.state === TenantProvisioningState.RUNNING
      ) {
        return current;
      }

      if (current.state === TenantProvisioningState.SUCCEEDED) {
        throw new ConflictException('Succeeded tenant provisioning operations cannot be retried');
      }

      if (current.state !== TenantProvisioningState.FAILED) {
        throw new ConflictException('Only failed tenant provisioning operations can be retried');
      }

      const retryOnboarding =
        current.currentStep === 'wait_for_onboarding_ack' ||
        current.currentStep === 'publish_onboarding_requested';

      const rows = await this.managerRows<TenantProvisioningRunRow>(
        manager,
        `UPDATE admin.tenant_provisioning_runs
            SET state = $2,
                "currentStep" = NULL,
                "lastError" = NULL,
                attempts = 0,
                "nextRetryAt" = NULL,
                "leaseToken" = NULL,
                "leasedBy" = NULL,
                "heartbeatAt" = NULL,
                "leaseExpiresAt" = NULL,
                "completedAt" = NULL,
                "onboardingRequestEventId" = CASE WHEN $3 THEN NULL ELSE "onboardingRequestEventId" END,
                "onboardingRequestedAt" = CASE WHEN $3 THEN NULL ELSE "onboardingRequestedAt" END,
                "updatedAt" = now()
          WHERE id = $1
          RETURNING id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
                    "actorUserId", state, "currentStep", "lastError", attempts,
                    "nextRetryAt", "leaseToken", "leasedBy", "heartbeatAt", "leaseExpiresAt",
                    "startedAt", "completedAt", "createdAt", "updatedAt"`,
        [operationId, TenantProvisioningState.QUEUED, retryOnboarding],
      );

      await this.managerRows(
        manager,
        `UPDATE admin.tenant_provisioning_steps
            SET state = $2,
                attempts = 0,
                "lastError" = NULL,
                "startedAt" = NULL,
                "completedAt" = NULL,
                "updatedAt" = now()
          WHERE "runId" = $1 AND state <> $3`,
        [operationId, TenantProvisioningState.QUEUED, TenantProvisioningState.SUCCEEDED],
      );

      if (retryOnboarding) {
        await this.managerRows(
          manager,
          `UPDATE admin.tenant_provisioning_steps
              SET state = $2,
                  attempts = 0,
                  "lastError" = NULL,
                  "startedAt" = NULL,
                  "completedAt" = NULL,
                  "updatedAt" = now()
            WHERE "runId" = $1
              AND "stepName" IN ('publish_onboarding_requested', 'wait_for_onboarding_ack')`,
          [operationId, TenantProvisioningState.QUEUED],
        );
      }

      shouldProcess = true;
      return rows[0];
    });

    if (shouldProcess) {
      this.processOperation(operationId).catch((error: Error) => {
        this.logger.error(`Retry processing failed for operation ${operationId}: ${error.message}`);
      });
    }

    return this.getOperation(operationId);
  }

  async processOperation(operationId: string): Promise<void> {
    const run = await this.claimRun(operationId);
    if (!run) return;

    try {
      const payload = this.parseCreatePayload(run.requestPayload);
      const leaseToken = run.leaseToken;

      await this.runStep(run.id, leaseToken, 'reserve_auth_tenant', async () => {
        await this.reserveAuthTenant(run, payload);
      });

      const tenant = await this.findTenantById(run.tenantId);
      if (!tenant) {
        throw new NotFoundException(`Tenant '${run.tenantId}' not found after auth reservation`);
      }

      // W3.3-c: PENDING → PROVISIONING before any provisioning work, so the
      // canonical lifecycle (PENDING → PROVISIONING → ACTIVE) is truthful and
      // the tenant's in-flight provisioning state is observable.
      await this.runStep(run.id, leaseToken, 'begin_provisioning', async () => {
        await this.beginProvisioning(run, tenant.id);
      });

      await this.runStep(run.id, leaseToken, 'audit_create_requested', async () => {
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

      await this.runStep(run.id, leaseToken, 'assign_modules', async () => {
        await this.assignModulesWithPricing(tenant, payload, run.actorUserId);
      });

      await this.runStep(run.id, leaseToken, 'publish_provisioning_requested', async () => {
        await this.requestDbMigrateTenantSchemaProvisioning(run, tenant, payload);
        await this.enqueueEvent(
          {
            ...createBaseEvent('TenantProvisioningRequested', tenant.id, {
              aggregateId: tenant.id,
              aggregateType: 'Tenant',
            }),
            slug: tenant.slug,
            name: tenant.name,
            operationId: run.id,
            moduleIds: payload.moduleIds,
          },
          'tenant-provisioning-requested:' + run.id,
        );
      });

      await this.runStep(run.id, leaseToken, 'wait_for_db_migrate_provisioner', async () => {
        await this.assertDbMigrateProvisionedTenantSchema(run.id, tenant.id);
      });

      await this.runStep(run.id, leaseToken, 'provision_application_resources', async () => {
        const adminEmail = tenant.primaryContact?.email ?? tenant.contactEmail;
        const result = await this.provisioningService.provisionTenant(tenant.id, {
          createFirstAdmin: adminEmail !== undefined,
          adminEmail,
          adminFirstName: this.getFirstName(tenant.primaryContact?.name),
          adminLastName: this.getLastName(tenant.primaryContact?.name),
          skipSchemaCreation: true,
          finalizeActivation: false,
          operationId: run.id,
          idempotencyKeyBase: run.idempotencyKey,
          payloadHash: run.requestHash,
          actorId: run.actorUserId,
        });

        if (!result.success) {
          throw new Error(result.error ?? 'Tenant resource provisioning failed');
        }
      });

      await this.runStep(run.id, leaseToken, 'publish_onboarding_requested', async () => {
        await this.publishTenantOnboardingRequest(run, tenant, payload);
      });

      await this.runStep(run.id, leaseToken, 'wait_for_onboarding_ack', async () => {
        await this.assertTenantOnboardingAcks(run.id);
      });

      await this.runStep(run.id, leaseToken, 'create_subscription', async () => {
        await this.createTenantSubscription(run, tenant, payload);
      });

      await this.runStep(run.id, leaseToken, 'activate_tenant', async () => {
        await this.activateTenantAfterVerification(run, tenant.id);
      });

      await this.runStep(run.id, leaseToken, 'audit_provisioned', async () => {
        await this.auditLogService.log({
          action: 'TENANT_PROVISIONED',
          entityType: 'tenant',
          entityId: tenant.id,
          performedBy: run.actorUserId,
          details: {
            operationId: run.id,
            moduleIds: payload.moduleIds,
            tenantStatus: TenantStatus.ACTIVE,
          },
        });
      });

      await this.runStep(run.id, leaseToken, 'publish_tenant_provisioned', async () => {
        await this.enqueueEvent(
          {
            ...createBaseEvent('TenantProvisioned', tenant.id, {
              aggregateId: tenant.id,
              aggregateType: 'Tenant',
            }),
            operationId: run.id,
            slug: tenant.slug,
            name: tenant.name,
          },
          'tenant-provisioned:' + run.id,
        );

        await this.enqueueEvent(
          {
            ...createBaseEvent('TenantCreated', tenant.id, {
              aggregateId: tenant.id,
              aggregateType: 'Tenant',
            }),
            slug: tenant.slug,
            name: tenant.name,
          },
          'tenant-created-final:' + run.id,
        );
      });

      await this.markRunSucceeded(run.id, leaseToken);
      this.logger.log(`Tenant provisioning operation ${run.id} completed for tenant ${tenant.id}`);
    } catch (error) {
      if (error instanceof ProvisioningWaitPendingError) {
        await this.markRunWaiting(run.id, error, run.leaseToken);
        return;
      }
      const markedFailed = await this.markRunFailed(run.id, error, run.leaseToken);
      if (markedFailed) {
        await this.publishFailure((await this.getRun(run.id)) ?? run, error);
      } else {
        this.logger.warn(
          `Skipping failure publish for operation ${run.id} because this worker no longer holds the lease`,
        );
      }
    }
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async processQueuedOperations(): Promise<void> {
    if (this.processingQueue) return;
    this.processingQueue = true;

    try {
      await this.requeueStaleRuns();
      await this.refreshActiveRunGauges();
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

  /**
   * Publish how many runs have not reached a terminal state and how old the
   * oldest one is.
   *
   * Production holds two runs in RUNNING with `attempts=3` and no lease right
   * now; before this, nothing counted them, so "provisioning is wedged" and
   * "nobody has created a tenant lately" produced identical telemetry.
   */
  private async refreshActiveRunGauges(): Promise<void> {
    try {
      const rows = await this.queryRows<{ active: string; oldestAgeSeconds: string | null }>(
        `SELECT count(*)::text AS active,
                COALESCE(EXTRACT(EPOCH FROM (now() - min("createdAt"))), 0)::text AS "oldestAgeSeconds"
           FROM admin.tenant_provisioning_runs
          WHERE state IN ($1, $2)`,
        [TenantProvisioningState.QUEUED, TenantProvisioningState.RUNNING],
      );
      const row = rows[0];
      this.metrics.recordActiveRuns(Number(row?.active ?? 0), Number(row?.oldestAgeSeconds ?? 0));
    } catch (error) {
      // A failed gauge refresh must not stop the queue from being drained:
      // the sweeper's job is to provision, and this is its narration.
      this.logger.warn(`Provisioning gauge refresh failed: ${(error as Error).message}`);
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
    if (trimmed && trimmed.length >= 16 && trimmed.length <= 128) return trimmed;

    throw new BadRequestException(
      'Idempotency-Key is required for tenant creation and must be 16-128 characters',
    );
  }

  private hashPayload(payload: CreateTenantDto): string {
    return crypto.createHash('sha256').update(this.stableStringify(payload)).digest('hex');
  }

  private async assertTenantOnboardingAcks(operationId: string): Promise<void> {
    const requiredServices = TENANT_ONBOARDING_WORKFLOW_V1.ownerServices;

    const command = (
      await this.queryRows<{
        tenantId: string;
        requestHash: string;
        onboardingAttempt: number;
        onboardingRequestEventId: string | null;
        elapsedMs: string | number | null;
      }>(
        `SELECT "tenantId", "requestHash", "onboardingAttempt", "onboardingRequestEventId",
                EXTRACT(EPOCH FROM (now() - "onboardingRequestedAt")) * 1000 AS "elapsedMs"
           FROM admin.tenant_provisioning_runs
          WHERE id = $1`,
        [operationId],
      )
    )[0];
    if (!command || command.onboardingAttempt < 1 || command.onboardingRequestEventId === null) {
      throw new Error(`Tenant onboarding command evidence is missing for operation ${operationId}`);
    }

    const rows = await this.queryRows<{
      service: string;
      status: 'ACK' | 'FAILED';
      error: string | null;
    }>(
      `SELECT service, status, error
         FROM admin.tenant_onboarding_acks
        WHERE "operationId" = $1
          AND attempt = $2
          AND "requestEventId" = $3
          AND "requestHash" = $4
          AND "schemaVersion" = $5`,
      [
        operationId,
        command.onboardingAttempt,
        command.onboardingRequestEventId,
        command.requestHash,
        TENANT_ONBOARDING_WORKFLOW_V1.schemaVersion,
      ],
    );
    const failed = rows.filter((row) => row.status === 'FAILED');
    if (failed.length > 0) {
      throw new Error(
        `Tenant onboarding failed from owner services: ${failed.map((row) => `${row.service}${row.error ? ` (${row.error})` : ''}`).join(', ')}`,
      );
    }
    const acked = new Set(rows.filter((row) => row.status === 'ACK').map((row) => row.service));
    const missing = requiredServices.filter((service) => !acked.has(service));
    if (missing.length === 0) {
      return;
    }

    const elapsedMs = Number(command.elapsedMs ?? 0);
    const deadlineMs = TENANT_ONBOARDING_WORKFLOW_V1.acknowledgementDeadlineSeconds * 1000;
    const message = `Tenant onboarding ack missing from owner services: ${missing.join(', ')}`;
    if (!Number.isFinite(elapsedMs) || elapsedMs >= deadlineMs) {
      throw new Error(`${message}; durable acknowledgement deadline exceeded`);
    }

    throw new ProvisioningWaitPendingError(
      'wait_for_onboarding_ack',
      ONBOARDING_ACK_RETRY_MS,
      message,
    );
  }

  private buildAuthCommandMetadata(
    commandType: string,
    operationId: string,
    tenantId: string,
    idempotencyKeyBase: string,
    requestHash: string,
    actorUserId: string,
    _payload: unknown,
  ): {
    operationId: string;
    tenantId: string;
    actor: { id: string; type: 'user' };
    requestReference: string;
    auditMetadata: Record<string, unknown>;
  } {
    return {
      operationId,
      tenantId,
      actor: { id: actorUserId, type: 'user' },
      requestReference: `${idempotencyKeyBase}:${commandType}`,
      auditMetadata: {
        source: 'admin-api-service',
        commandType,
        requestPayloadHash: requestHash,
      },
    };
  }

  private stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }

    if (this.isRecord(value)) {
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${this.stableStringify(value[key])}`)
        .join(',')}}`;
    }

    return JSON.stringify(value);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  /**
   * Best-effort, UNLOCKED duplicate pre-check for fast 409 UX feedback before the
   * operation is queued.
   *
   * WHY no row lock: `Tenant` maps to `auth.tenants`, which auth-service owns
   * (D14) and admin-api may only READ (SEC-015 least-privilege). A row lock
   * (`FOR SHARE`/`FOR UPDATE`) requires the UPDATE privilege in PostgreSQL, so a
   * `lock: { mode: 'pessimistic_read' }` here was both illegal for a read-only
   * role AND useless — the authoritative tenant row is inserted later and
   * asynchronously by auth-service's `reserveTenant` (processOperation →
   * reserve_auth_tenant), so a lock taken in THIS short transaction guards no
   * write it controls and is released at commit long before auth-service inserts.
   *
   * Uniqueness SSoT: auth-service `reserveTenant` enforces it inside its
   * SERIALIZABLE receipt transaction, backed by the DB unique constraints on
   * `auth.tenants.slug` (UQ) and `auth.tenants.customDomain` (partial UQ). A true
   * race that slips past this best-effort pre-check is rejected there with a
   * ConflictException, failing the run with a clear error — never a silent
   * duplicate. This pre-check only short-circuits the obvious case early.
   */
  private async assertNoDuplicateTenant(
    manager: EntityManager,
    data: CreateTenantDto,
  ): Promise<void> {
    if (data.slug) {
      const existingBySlug = await manager.findOne(Tenant, {
        where: { slug: data.slug },
      });

      if (existingBySlug) {
        throw new ConflictException(`Tenant with slug '${data.slug}' already exists`);
      }
    }

    if (data.domain) {
      const existingByDomain = await manager.findOne(Tenant, {
        where: { customDomain: data.domain },
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
      trialEndsAt: this.getTrialEndsAt(data.trialDays),
      createdBy: actorUserId,
      userCount: 0,
    };
  }

  private createTenantDraft(
    tenantId: string,
    payload: CreateTenantDto,
    actorUserId: string,
  ): Tenant {
    const tenant = Object.assign(new Tenant(), {
      ...this.toTenantEntity(payload, actorUserId),
      id: tenantId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    tenant.hydrateCompatibilityFields();
    return this.hydrateCreatedTenant(tenant, payload);
  }

  private async reserveAuthTenant(
    run: TenantProvisioningRunRow,
    payload: CreateTenantDto,
  ): Promise<void> {
    const tenantDraft = this.createTenantDraft(run.tenantId, payload, run.actorUserId);

    await this.authProvisioningClient.reserveTenant({
      ...this.buildAuthCommandMetadata(
        'ReserveTenant',
        run.id,
        run.tenantId,
        run.idempotencyKey,
        run.requestHash,
        run.actorUserId,
        this.toSafeRequestPayload(payload),
      ),
      name: tenantDraft.name,
      slug: tenantDraft.slug,
      description: tenantDraft.description,
      customDomain: tenantDraft.customDomain,
      contactEmail: tenantDraft.contactEmail,
      contactPhone: tenantDraft.contactPhone,
      plan: tenantDraft.plan,
      maxUsers: tenantDraft.maxUsers,
      maxStorage: tenantDraft.maxStorage,
      trialEndsAt: tenantDraft.trialEndsAt?.toISOString(),
      settings: tenantDraft.settings as Record<string, unknown> | undefined,
      createdBy: run.actorUserId,
    });
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

  private toSafeRequestPayload(data: CreateTenantDto): Partial<CreateTenantDto> {
    return {
      name: data.name,
      slug: data.slug,
      description: data.description,
      plan: data.plan,
      tier: data.tier,
      country: data.country,
      region: data.region,
      trialDays: data.trialDays,
      maxUsers: data.maxUsers,
      maxStorage: data.maxStorage,
      limits: data.limits,
      settings: data.settings
        ? {
            timezone: data.settings.timezone,
            locale: data.settings.locale,
            currency: data.settings.currency,
            dateFormat: data.settings.dateFormat,
            measurementSystem: data.settings.measurementSystem,
            notificationPreferences: data.settings.notificationPreferences,
            features: data.settings.features,
          }
        : undefined,
      moduleIds: data.moduleIds ?? [],
      moduleQuantities: data.moduleQuantities,
      billingCycle: data.billingCycle,
      catalogVersionId: data.catalogVersionId,
      quoteId: data.quoteId,
      customPlanId: data.customPlanId,
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

  private tenantFromSnapshot(
    snapshot:
      | {
          id?: string;
          name?: string;
          slug?: string;
          status?: string;
          plan?: string;
          customDomain?: string | null;
          contactEmail?: string | null;
          contactPhone?: string | null;
          settings?: TenantSettings | null;
          createdAt?: string;
          updatedAt?: string;
        }
      | undefined,
    fallback: Tenant,
  ): Tenant {
    if (!snapshot) return fallback;
    const tenant: Tenant = Object.assign(new Tenant(), {
      id: snapshot.id ?? fallback.id,
      name: snapshot.name ?? fallback.name,
      slug: snapshot.slug ?? fallback.slug,
      status: snapshot.status ?? fallback.status,
      plan: snapshot.plan ?? fallback.plan,
      customDomain: snapshot.customDomain ?? fallback.customDomain,
      contactEmail: snapshot.contactEmail ?? fallback.contactEmail,
      contactPhone: snapshot.contactPhone ?? fallback.contactPhone,
      settings: snapshot.settings ?? fallback.settings,
      createdBy: fallback.createdBy,
      maxUsers: fallback.maxUsers,
      maxStorage: fallback.maxStorage,
      // MT-MEDIUM-001: isTrialActive is now derived from trialEndsAt — copy the
      // SSoT source, not the dropped boolean, so the rebuilt tenant keeps its
      // trial window.
      trialEndsAt: fallback.trialEndsAt,
      userCount: 0,
      createdAt: snapshot.createdAt ? new Date(snapshot.createdAt) : new Date(),
      updatedAt: snapshot.updatedAt ? new Date(snapshot.updatedAt) : new Date(),
    });
    tenant.hydrateCompatibilityFields();
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

    const result = await this.moduleAssignmentService.assignModulesToTenant({
      tenantId: tenant.id,
      modules: this.buildModuleQuantityInputs(data),
      assignedBy,
      tier: this.toModulePlanTier(tenant.tier),
      billingCycle: this.toModuleBillingCycle(data.billingCycle),
    });

    if (!result.success) {
      throw new Error(
        `Module assignment failed: ${result.failedModules.map((f) => `${f.moduleId}:${f.error}`).join(', ')}`,
      );
    }
  }

  private async createTenantSubscription(
    run: TenantProvisioningRunRow,
    tenant: Tenant,
    data: CreateTenantDto,
  ): Promise<void> {
    // ORPHAN-CRITICAL-393 / ORPHAN-HIGH-394: resolve each module's code, name,
    // and REAL price (admin.module_pricing via PricingCalculatorService) in
    // admin-api — the schema owner of that data — and pass priced moduleItems in
    // the command. billing writes the module rows directly from these values, so
    // it never runs the schema-unqualified `modules` query that failed (no
    // billing grant on auth.modules) and rolled the whole subscription back, and
    // never invents $0 module prices.
    const moduleItems = await this.moduleAssignmentService.resolveProvisioningModuleItems({
      modules: this.buildModuleQuantityInputs(data),
      tier: this.toModulePlanTier(tenant.tier),
      billingCycle: this.toModuleBillingCycle(data.billingCycle),
    });

    const result = await this.billingCommandClient.provisionTenantSubscription({
      operationId: run.id,
      tenantId: tenant.id,
      idempotencyKey: `${run.idempotencyKey}:ProvisionTenantSubscription:${run.requestHash}`,
      requestPayloadHash: run.requestHash,
      actorId: run.actorUserId,
      tenantName: tenant.name,
      tier: this.toBillingCommandPlanTier(tenant.tier),
      billingCycle: this.toBillingCommandCycle(data.billingCycle),
      moduleIds: data.moduleIds ?? [],
      moduleQuantities: data.moduleQuantities,
      moduleItems,
      trialDays: data.trialDays,
      catalogVersionId: data.catalogVersionId,
      quoteId: data.quoteId,
      customPlanId: data.customPlanId,
    });

    if (!result.subscriptionId || !result.receiptId) {
      throw new Error('Billing provisioning completed without subscription receipt evidence');
    }
  }

  /**
   * Idempotent backfill: create the missing billing subscription for an already
   * provisioned tenant by REUSING the fixed provisioning command path.
   *
   * WHY a command, not a SQL migration: the correct subscription price is the
   * sum of module prices computed by PricingCalculatorService (admin.module_pricing).
   * Reimplementing that in a migration's SQL would resurrect the parallel pricing
   * model this PR deletes. Instead we resolve the tenant's assigned modules
   * (auth.tenant_modules) into priced moduleItems and send the SAME
   * PROVISION_TENANT_SUBSCRIPTION command tenant creation now uses.
   *
   * Idempotent: billing short-circuits on an existing active subscription
   * (`findActiveSubscription` + the partial unique index UQ_subscriptions_tenantId_active)
   * and on the command receipt, so re-invoking for a tenant that already has a
   * subscription replays rather than duplicating. Safe to run against live money
   * data. Invoked by the lead post-deploy (POST /admin/tenants/:id/reconcile-subscription)
   * for the 3 pre-existing tenants that were created while the provisioning tx
   * silently rolled back (ORPHAN-CRITICAL-393).
   */
  async reconcileTenantSubscription(
    tenantId: string,
    actorId: string,
  ): Promise<{
    tenantId: string;
    subscriptionId?: string;
    status?: string;
    moduleItemCount?: number;
    replayed?: boolean;
  }> {
    const tenant = await this.findTenantById(tenantId);
    if (!tenant) {
      throw new NotFoundException(`Tenant '${tenantId}' not found`);
    }

    const assignedModules =
      await this.moduleAssignmentService.getTenantModulesWithPricing(tenantId);
    const billingCycle: CreateTenantDto['billingCycle'] = 'monthly';
    const moduleItems = await this.moduleAssignmentService.resolveProvisioningModuleItems({
      modules: assignedModules.map((module) => ({
        moduleId: module.moduleId,
        quantities: module.quantities,
      })),
      tier: this.toModulePlanTier(tenant.tier),
      billingCycle: this.toModuleBillingCycle(billingCycle),
    });

    // Deterministic operation identity so repeated reconciles converge on ONE
    // billing command receipt (the subscription itself is deduped regardless).
    const seed = `reconcile-subscription:${tenantId}`;
    const operationId = this.deterministicUuid(seed);
    const requestPayloadHash = crypto
      .createHash('sha256')
      .update(
        this.stableStringify({
          tenantId,
          tier: tenant.tier,
          billingCycle,
          moduleIds: assignedModules.map((module) => module.moduleId),
        }),
      )
      .digest('hex');

    const result = await this.billingCommandClient.provisionTenantSubscription({
      operationId,
      tenantId,
      idempotencyKey: seed,
      requestPayloadHash,
      actorId,
      tenantName: tenant.name,
      tier: this.toBillingCommandPlanTier(tenant.tier),
      billingCycle: this.toBillingCommandCycle(billingCycle),
      moduleIds: assignedModules.map((module) => module.moduleId),
      moduleItems,
    });

    return {
      tenantId,
      subscriptionId: result.subscriptionId,
      status: result.status,
      moduleItemCount: result.moduleItemCount,
      replayed: result.replayed,
    };
  }

  private deterministicUuid(seed: string): string {
    const hex = crypto.createHash('sha256').update(seed).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  /**
   * Build the per-module quantity inputs shared by the assign_modules step
   * (auth-service module assignment + pricing) and the create_subscription step
   * (billing module-item pricing resolution). A single builder keeps both saga
   * steps deriving quantities identically from the same request payload.
   */
  private buildModuleQuantityInputs(
    data: CreateTenantDto,
  ): Array<{ moduleId: string; quantities: ModuleQuantities }> {
    const moduleIds = data.moduleIds ?? [];
    return moduleIds.map((moduleId) => {
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
      if ((error as { code?: string }).code === '23505') {
        this.logger.warn(
          `Outbox idempotency key already exists; treating as completed: ${idempotencyKey}`,
        );
        return;
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async publishTenantOnboardingRequest(
    run: TenantProvisioningRunRow,
    tenant: Tenant,
    payload: CreateTenantDto,
  ): Promise<void> {
    const moduleIds = payload.moduleIds;
    if (!moduleIds || moduleIds.length === 0) {
      throw new Error('Tenant onboarding command requires at least one governed module ID');
    }

    await this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const command = (
        await this.managerRows<{
          onboardingAttempt: number;
          onboardingRequestEventId: string | null;
        }>(
          manager,
          `SELECT "onboardingAttempt", "onboardingRequestEventId"
             FROM admin.tenant_provisioning_runs
            WHERE id = $1
              AND "leaseToken" = $2
              AND state = 'RUNNING'
            FOR UPDATE`,
          [run.id, run.leaseToken],
        )
      )[0];
      if (!command) {
        throw new Error('Provisioning lease lost before publishing tenant onboarding command');
      }

      // If the process crashed after the command/outbox transaction committed
      // but before runStep marked the step complete, the command coordinates are
      // already durable. Reusing them avoids a second mutation generation.
      if (command.onboardingRequestEventId !== null) {
        return;
      }

      const attempt = command.onboardingAttempt + 1;
      const event: TenantOnboardingRequestedEvent = {
        ...createBaseEvent<TenantOnboardingRequestedEvent>(
          TENANT_ONBOARDING_WORKFLOW_V1.request.eventType,
          tenant.id,
          {
            aggregateId: tenant.id,
            aggregateType: 'Tenant',
            correlationId: run.id,
          },
        ),
        operationId: run.id,
        attempt,
        requestHash: run.requestHash,
        slug: tenant.slug,
        name: tenant.name,
        moduleIds,
      };

      const updated = await this.managerRows<{ id: string }>(
        manager,
        `UPDATE admin.tenant_provisioning_runs
            SET "onboardingAttempt" = $3,
                "onboardingRequestEventId" = $4,
                "onboardingRequestedAt" = now(),
                "updatedAt" = now()
          WHERE id = $1
            AND "leaseToken" = $2
            AND state = 'RUNNING'
            AND "onboardingRequestEventId" IS NULL
        RETURNING id`,
        [run.id, run.leaseToken, attempt, event.eventId],
      );
      if (!updated[0]) {
        throw new Error('Provisioning lease lost while recording tenant onboarding command');
      }

      await this.outboxPublisher.enqueue(event, manager, {
        aggregateId: tenant.id,
        idempotencyKey: `tenant-onboarding-requested:${run.id}:${attempt}`,
      });
    });
  }

  private toModulePlanTier(value: string | undefined): ModulePlanTier {
    // FREE is a first-class tier (Billing Revival Faz B) — it must pass through,
    // NOT collapse to STARTER. The FREE multiplier is $0 in module-pricing, so a
    // FREE tenant's resolved module items price to $0 rather than being charged
    // at STARTER rates. CUSTOM/ENTERPRISE keep their existing mapping.
    const tierMap: Record<string, ModulePlanTier> = {
      free: ModulePlanTier.FREE,
      starter: ModulePlanTier.STARTER,
      professional: ModulePlanTier.PROFESSIONAL,
      enterprise: ModulePlanTier.ENTERPRISE,
      custom: ModulePlanTier.CUSTOM,
    };
    return tierMap[value?.toLowerCase() ?? 'starter'] ?? ModulePlanTier.STARTER;
  }

  private toModuleBillingCycle(value: CreateTenantDto['billingCycle']): ModuleBillingCycle {
    const cycleMap: Record<string, ModuleBillingCycle> = {
      monthly: ModuleBillingCycle.MONTHLY,
      quarterly: ModuleBillingCycle.QUARTERLY,
      semi_annual: ModuleBillingCycle.SEMI_ANNUAL,
      annual: ModuleBillingCycle.ANNUAL,
    };
    return cycleMap[value ?? 'monthly'] ?? ModuleBillingCycle.MONTHLY;
  }

  private toBillingCommandPlanTier(value: string | undefined): BillingCommandPlanTier {
    // FREE passes through on the wire (Billing Revival Faz B): the billing
    // command's PlanTier now legitimately accepts 'free', so a FREE tenant
    // provisions a real plan_tier='free' subscription instead of being silently
    // downgraded to 'starter'. (CUSTOM is not a billing-command tier — enterprise
    // custom plans travel via customPlanId, so it is intentionally absent here.)
    const tierMap: Record<string, BillingCommandPlanTier> = {
      free: 'free',
      starter: 'starter',
      professional: 'professional',
      enterprise: 'enterprise',
    };
    return tierMap[value?.toLowerCase() ?? 'starter'] ?? 'starter';
  }

  private toBillingCommandCycle(
    value: CreateTenantDto['billingCycle'],
  ): BillingCommandBillingCycle {
    const cycleMap: Record<string, BillingCommandBillingCycle> = {
      monthly: 'monthly',
      quarterly: 'quarterly',
      semi_annual: 'semi_annual',
      annual: 'annual',
    };
    return cycleMap[value ?? 'monthly'] ?? 'monthly';
  }

  private getFirstName(fullName?: string): string {
    return fullName?.trim().split(/\s+/)[0] || 'Admin';
  }

  private getLastName(fullName?: string): string {
    const parts = fullName?.trim().split(/\s+/).slice(1) ?? [];
    return parts.length > 0 ? parts.join(' ') : 'User';
  }

  private async assertDbMigrateProvisionedTenantSchema(
    operationId: string,
    tenantId: string,
  ): Promise<void> {
    const expectedSchemaName = getTenantSchemaName(tenantId);
    const jobRows = await this.queryRows<{
      status: string;
      errorMessage: string | null;
    }>(
      `SELECT status,
              error_message AS "errorMessage"
         FROM platform.tenant_schema_jobs
        WHERE operation_id = $1::uuid
          AND tenant_id = $2::uuid
          AND schema_name = $3
          AND job_type = 'PROVISION'
        LIMIT 1`,
      [operationId, tenantId, expectedSchemaName],
    );
    const jobRow = jobRows[0];
    if (jobRow?.status === 'FAILED' || jobRow?.status === 'ABORTED') {
      throw new Error(
        `db-migrate tenant provisioner ${jobRow.status.toLowerCase()} operation ${operationId} for tenant ${tenantId}: ${jobRow.errorMessage ?? 'no error message'}`,
      );
    }

    const schemaRows = await this.queryRows<{
      schemaName: string;
      tableCount: number;
      evidenceOperationId: string | null;
      jobStatus: string;
    }>(
      `SELECT ts."schemaName" AS "schemaName",
              ts."tableCount" AS "tableCount",
              ts.metadata->>'operationId' AS "evidenceOperationId",
              j.status AS "jobStatus"
         FROM admin.tenant_schemas ts
         JOIN platform.tenant_schema_jobs j
           ON j.operation_id = $1::uuid
          AND j.tenant_id = ts."tenantId"
          AND j.schema_name = ts."schemaName"
          AND j.job_type = 'PROVISION'
        WHERE ts."tenantId" = $2::uuid
          AND ts."schemaName" = $3
          AND ts.status = 'active'
          AND ts.metadata->>'operationId' = $1
          AND j.status = 'COMMITTED'
        LIMIT 1`,
      [operationId, tenantId, expectedSchemaName],
    );
    const schemaRow = schemaRows[0];
    if (!schemaRow?.schemaName) {
      throw new ProvisioningWaitPendingError(
        'wait_for_db_migrate_provisioner',
        DB_MIGRATE_PROVISIONER_RETRY_MS,
        `db-migrate tenant provisioner has not completed operation ${operationId} for tenant ${tenantId}`,
      );
    }
    if (
      schemaRow.schemaName !== expectedSchemaName ||
      schemaRow.evidenceOperationId !== operationId ||
      schemaRow.jobStatus !== 'COMMITTED'
    ) {
      throw new Error(
        `db-migrate tenant provisioner wrote mismatched schema evidence for operation ${operationId} tenant ${tenantId}`,
      );
    }
    if (Number(schemaRow.tableCount ?? 0) <= 0) {
      throw new Error(
        `db-migrate tenant provisioner wrote empty schema ledger for operation ${operationId} tenant ${tenantId}`,
      );
    }

    // The ledger says "provisioned". Only the database can say "true".
    await this.assertTenantSchemaPhysicallyMatchesLedger(
      tenantId,
      'wait_for_db_migrate_provisioner',
    );

    this.logger.log(
      `db-migrate tenant schema ledger and physical schema confirmed for tenant ${tenantId}: ${schemaRow.schemaName}`,
    );
  }

  /**
   * Reconcile the provisioning ledger against the physical database.
   *
   * WHY: every check above this one reads a ROW that claims a schema exists —
   * admin.tenant_schemas joined to platform.tenant_schema_jobs. Two rows agreeing
   * with each other is not evidence that `tenant_<id>` was ever created, which is
   * how production ended up with an ACTIVE tenant that owns no schema: the ledger
   * was intact, the schema was not, and the saga walked straight past it to
   * activation. Ledger-vs-reality divergence is corruption, not slowness, so this
   * throws a plain Error (terminal FAILED) rather than
   * DbMigrateProvisioningPendingError (retry-and-wait) — retrying cannot conjure a
   * schema the provisioner never committed.
   */
  private async assertTenantSchemaPhysicallyMatchesLedger(
    tenantId: string,
    phase: string,
  ): Promise<void> {
    const expectedSchemaName = getTenantSchemaName(tenantId);
    const ledgerRows = await this.queryRows<{ tableCount: number }>(
      `SELECT ts."tableCount" AS "tableCount"
         FROM admin.tenant_schemas ts
        WHERE ts."tenantId" = $1::uuid
          AND ts."schemaName" = $2
          AND ts.status = 'active'
        LIMIT 1`,
      [tenantId, expectedSchemaName],
    );
    const ledgerRow = ledgerRows[0];
    if (!ledgerRow) {
      throw new Error(
        `tenant schema ledger has no active row for tenant ${tenantId} schema ${expectedSchemaName} at ${phase}`,
      );
    }
    const ledgerTableCount = Number(ledgerRow.tableCount ?? 0);

    const physical = await this.readPhysicalTenantSchemaFacts(expectedSchemaName);
    if (!physical.schemaExists) {
      throw new Error(
        `tenant schema ledger claims ${expectedSchemaName} is active for tenant ${tenantId}, but the physical schema does not exist at ${phase}`,
      );
    }
    if (physical.tableCount <= 0) {
      throw new Error(
        `physical tenant schema ${expectedSchemaName} for tenant ${tenantId} contains no tables at ${phase}`,
      );
    }
    // Only a SHORTFALL is corruption. A surplus is the normal result of later
    // MIGRATE jobs adding tables after the PROVISION job wrote its count, so
    // demanding exact equality would fail healthy tenants.
    if (physical.tableCount < ledgerTableCount) {
      throw new Error(
        `tenant schema ${expectedSchemaName} for tenant ${tenantId} has ${physical.tableCount} tables but the ledger claims ${ledgerTableCount} at ${phase}`,
      );
    }
  }

  /**
   * Read schema existence and BASE TABLE count straight from the catalog.
   *
   * WHY pg_catalog and NOT information_schema: information_schema.schemata and
   * information_schema.tables are privilege-filtered views — they expose only
   * objects the CURRENT role owns or holds a grant on. admin-api connects as the
   * least-privilege `admin_service` role, which holds no grants inside tenant_*
   * schemas, so an information_schema probe would report "schema missing, 0
   * tables" for a perfectly healthy tenant and fail every provisioning run.
   * pg_catalog.pg_namespace / pg_class are visible to every role, which is why
   * platform.list_tenant_schema_mappings
   * (apps/db-migrate/src/sql/platform-bootstrap/009-tenant-schema-provisioner.sql)
   * already derives its `schema_exists` proof from pg_namespace.
   *
   * relkind IN ('r','p') is the exact pg_class equivalent of information_schema's
   * `table_type = 'BASE TABLE'` (ordinary + partitioned tables), so the count is
   * comparable with the ledger's tableCount, which db-migrate writes with that
   * information_schema predicate under its own privileged role.
   */
  private async readPhysicalTenantSchemaFacts(
    schemaName: string,
  ): Promise<{ schemaExists: boolean; tableCount: number }> {
    const rows = await this.queryRows<{ schemaExists: boolean; tableCount: number }>(
      `SELECT EXISTS (
                SELECT 1
                  FROM pg_catalog.pg_namespace n
                 WHERE n.nspname = $1
              ) AS "schemaExists",
              (
                SELECT count(*)
                  FROM pg_catalog.pg_class c
                  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = $1
                   AND c.relkind IN ('r', 'p')
              )::int AS "tableCount"`,
      [schemaName],
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`Physical schema probe returned no row for ${schemaName}`);
    }
    return { schemaExists: row.schemaExists === true, tableCount: Number(row.tableCount ?? 0) };
  }

  private async requestDbMigrateTenantSchemaProvisioning(
    run: TenantProvisioningRunRow,
    tenant: Tenant,
    payload: CreateTenantDto,
  ): Promise<void> {
    const schemaName = getTenantSchemaName(tenant.id);
    const rows = await this.queryRows<{ job_id: string }>(
      `SELECT platform.request_tenant_schema_provisioning(
         $1::uuid,
         $2::uuid,
         $3::text,
         $4::jsonb
       ) AS job_id`,
      [
        run.id,
        tenant.id,
        schemaName,
        JSON.stringify({
          operationId: run.id,
          tenantId: tenant.id,
          slug: tenant.slug,
          name: tenant.name,
          moduleIds: payload.moduleIds,
          requestHash: run.requestHash,
          actorUserId: run.actorUserId,
        }),
      ],
    );
    const jobId = rows[0]?.job_id;
    if (!jobId) {
      throw new Error(
        `db-migrate tenant schema provision request did not return a job id for operation ${run.id}`,
      );
    }
    this.logger.log(
      `Queued db-migrate tenant schema job ${jobId} for operation ${run.id} tenant ${tenant.id}`,
    );
  }

  /**
   * PENDING → PROVISIONING (W3.3-c). Issued right after the tenant is reserved
   * and before any provisioning work, so the in-flight provisioning phase is a
   * real, observable status and the canonical TenantStatusMachine governs the
   * lifecycle with no PENDING→ACTIVE skip. auth-service is the sole writer.
   */
  private async beginProvisioning(run: TenantProvisioningRunRow, tenantId: string): Promise<void> {
    await this.authProvisioningClient.beginProvisioning({
      ...this.buildAuthCommandMetadata(
        'BeginProvisioning',
        run.id,
        tenantId,
        run.idempotencyKey,
        run.requestHash,
        run.actorUserId,
        { step: 'begin_provisioning' },
      ),
    });
  }

  /**
   * ACTIVE is the promise that the tenant can serve traffic, so the schema check
   * is re-run immediately before it — the method name is a contract, not a label.
   *
   * WHY re-run something wait_for_db_migrate_provisioner already proved: runStep
   * short-circuits any step already marked SUCCEEDED, so on a retry (or after a
   * lease handover) the verification step is SKIPPED entirely and its evidence is
   * an old row. A schema that existed during the first attempt but was dropped or
   * rolled back before activation would otherwise be invisible, and the tenant
   * would be flipped ACTIVE over nothing.
   */
  private async activateTenantAfterVerification(
    run: TenantProvisioningRunRow,
    tenantId: string,
  ): Promise<void> {
    await this.assertTenantSchemaPhysicallyMatchesLedger(tenantId, 'activate_tenant');
    await this.assertTenantOnboardingAcks(run.id);

    await this.authProvisioningClient.activateTenant({
      ...this.buildAuthCommandMetadata(
        'ActivateTenant',
        run.id,
        tenantId,
        run.idempotencyKey,
        run.requestHash,
        run.actorUserId,
        { step: 'activate_tenant' },
      ),
    });
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
    const leaseToken = crypto.randomUUID();
    const workerId = this.getWorkerId();
    const rows = await this.queryRows<TenantProvisioningRunRow>(
      `UPDATE admin.tenant_provisioning_runs
          SET state = $2,
              attempts = attempts + 1,
              "leaseToken" = $5,
              "leasedBy" = $6,
              "heartbeatAt" = now(),
              "leaseExpiresAt" = now() + ($7::text)::interval,
              "startedAt" = COALESCE("startedAt", now()),
              "completedAt" = NULL,
              "updatedAt" = now()
        WHERE id = $1
          AND state = $3
          AND attempts < $4
          AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= now())
        RETURNING id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
                  "actorUserId", state, "currentStep", "lastError", attempts,
                  "nextRetryAt", "leaseToken", "leasedBy", "heartbeatAt", "leaseExpiresAt",
                  "startedAt", "completedAt", "createdAt", "updatedAt"`,
      [
        operationId,
        TenantProvisioningState.RUNNING,
        TenantProvisioningState.QUEUED,
        MAX_OPERATION_ATTEMPTS,
        leaseToken,
        workerId,
        `${OPERATION_LEASE_MS} milliseconds`,
      ],
    );
    return rows[0] ?? null;
  }

  private async seedProvisioningSteps(manager: EntityManager, runId: string): Promise<void> {
    for (const [index, stepName] of PROVISIONING_STEPS.entries()) {
      await manager.query(
        `INSERT INTO admin.tenant_provisioning_steps (
           id, "runId", "stepName", "stepOrder", state, attempts, "createdAt", "updatedAt"
         ) VALUES (
           uuid_generate_v4(), $1, $2, $3, $4, 0, now(), now()
         )
         ON CONFLICT ("runId", "stepName")
         DO UPDATE SET
           "stepOrder" = EXCLUDED."stepOrder",
           "updatedAt" = now()`,
        [runId, stepName, index + 1, TenantProvisioningState.QUEUED],
      );
    }
  }

  private stepOrder(stepName: ProvisioningStepName): number {
    return PROVISIONING_STEPS.indexOf(stepName) + 1;
  }

  private getWorkerId(): string {
    return `${process.env.HOSTNAME ?? 'admin-api'}:${process.pid}`;
  }

  private async extendLease(runId: string, leaseToken: string | null | undefined): Promise<void> {
    if (!leaseToken) {
      throw new Error('Provisioning run does not have a lease token');
    }

    const rows = await this.queryRows<TenantProvisioningRunRow>(
      `UPDATE admin.tenant_provisioning_runs
          SET "heartbeatAt" = now(),
              "leaseExpiresAt" = now() + ($3::text)::interval,
              "updatedAt" = now()
        WHERE id = $1
          AND "leaseToken" = $2
          AND state = 'RUNNING'
        RETURNING id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
                  "actorUserId", state, "currentStep", "lastError", attempts,
                  "nextRetryAt", "leaseToken", "leasedBy", "heartbeatAt", "leaseExpiresAt",
                  "startedAt", "completedAt", "createdAt", "updatedAt"`,
      [runId, leaseToken, `${OPERATION_LEASE_MS} milliseconds`],
    );

    if (rows.length === 0) {
      throw new Error('Provisioning lease is no longer held by this worker');
    }
  }

  private async runStep(
    runId: string,
    leaseToken: string | null | undefined,
    stepName: ProvisioningStepName,
    work: () => Promise<void>,
  ): Promise<void> {
    const existingRows = await this.queryRows<TenantProvisioningStepRow>(
      `SELECT "stepName", state, "stepOrder", attempts, "lastError", "startedAt", "completedAt"
         FROM admin.tenant_provisioning_steps
        WHERE "runId" = $1 AND "stepName" = $2
        LIMIT 1`,
      [runId, stepName],
    );

    if (existingRows[0]?.state === TenantProvisioningState.SUCCEEDED) {
      return;
    }

    await this.extendLease(runId, leaseToken);

    await this.queryRows<TenantProvisioningStepRow>(
      `INSERT INTO admin.tenant_provisioning_steps (
          id, "runId", "stepName", "stepOrder", state, attempts, "startedAt", "createdAt", "updatedAt"
        ) VALUES (
          uuid_generate_v4(), $1, $2, COALESCE($4, 999), $3, 1, now(), now(), now()
        )
        ON CONFLICT ("runId", "stepName")
        DO UPDATE SET
          state = $3,
          attempts = admin.tenant_provisioning_steps.attempts + 1,
          "startedAt" = now(),
          "completedAt" = NULL,
          "lastError" = NULL,
          "updatedAt" = now()
        RETURNING "stepName", state, "stepOrder", attempts, "lastError", "startedAt", "completedAt"`,
      [runId, stepName, TenantProvisioningState.RUNNING, this.stepOrder(stepName)],
    );

    const updatedRuns = await this.queryRows<TenantProvisioningRunRow>(
      `UPDATE admin.tenant_provisioning_runs
          SET "currentStep" = $2,
              "heartbeatAt" = now(),
              "leaseExpiresAt" = now() + ($4::text)::interval,
              "updatedAt" = now()
        WHERE id = $1
          AND "leaseToken" = $3
          AND state = 'RUNNING'
        RETURNING id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
                  "actorUserId", state, "currentStep", "lastError", attempts,
                  "nextRetryAt", "leaseToken", "leasedBy", "heartbeatAt", "leaseExpiresAt",
                  "startedAt", "completedAt", "createdAt", "updatedAt"`,
      [runId, stepName, leaseToken, `${OPERATION_LEASE_MS} milliseconds`],
    );
    if (updatedRuns.length === 0) {
      throw new Error(`Provisioning lease lost before step ${stepName}`);
    }

    const stepStartedAt = Date.now();
    try {
      await work();
      this.metrics.recordStepOutcome(stepName, 'success', (Date.now() - stepStartedAt) / 1000);
      await this.extendLease(runId, leaseToken);
      const rows = await this.queryRows<TenantProvisioningStepRow>(
        `UPDATE admin.tenant_provisioning_steps
            SET state = $3,
                "completedAt" = now(),
                "lastError" = NULL,
                "updatedAt" = now()
          WHERE "runId" = $1 AND "stepName" = $2
            AND EXISTS (
              SELECT 1
                FROM admin.tenant_provisioning_runs r
               WHERE r.id = $1
                 AND r."leaseToken" = $4
                 AND r.state = 'RUNNING'
            )
          RETURNING "stepName", state, "stepOrder", attempts, "lastError", "startedAt", "completedAt"`,
        [runId, stepName, TenantProvisioningState.SUCCEEDED, leaseToken],
      );
      if (rows.length === 0) {
        throw new Error(`Provisioning lease lost before completing step ${stepName}`);
      }
    } catch (error) {
      this.metrics.recordStepOutcome(stepName, 'failure', (Date.now() - stepStartedAt) / 1000);
      try {
        await this.extendLease(runId, leaseToken);
        await this.queryRows<TenantProvisioningStepRow>(
          `UPDATE admin.tenant_provisioning_steps
              SET state = $3,
                  "completedAt" = now(),
                  "lastError" = $4,
                  "updatedAt" = now()
            WHERE "runId" = $1 AND "stepName" = $2
              AND EXISTS (
                SELECT 1
                  FROM admin.tenant_provisioning_runs r
                 WHERE r.id = $1
                   AND r."leaseToken" = $5
                   AND r.state = 'RUNNING'
              )
            RETURNING "stepName", state, "stepOrder", attempts, "lastError", "startedAt", "completedAt"`,
          [runId, stepName, TenantProvisioningState.FAILED, this.errorMessage(error), leaseToken],
        );
      } catch (leaseError) {
        this.logger.warn(
          `Skipping failed step write for ${stepName}; lease no longer held: ${(leaseError as Error).message}`,
        );
      }
      throw error;
    }
  }

  private async markRunSucceeded(
    runId: string,
    leaseToken: string | null | undefined,
  ): Promise<void> {
    this.metrics.recordRunTerminal(TenantProvisioningState.SUCCEEDED);
    const rows = await this.queryRows<TenantProvisioningRunRow>(
      `UPDATE admin.tenant_provisioning_runs
          SET state = $2,
              "currentStep" = NULL,
              "lastError" = NULL,
              "leaseToken" = NULL,
              "leasedBy" = NULL,
              "heartbeatAt" = NULL,
              "leaseExpiresAt" = NULL,
              "completedAt" = now(),
              "updatedAt" = now()
        WHERE id = $1
          AND "leaseToken" = $3
          AND state = 'RUNNING'
        RETURNING id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
                  "actorUserId", state, "currentStep", "lastError", attempts,
                  "nextRetryAt", "leaseToken", "leasedBy", "heartbeatAt", "leaseExpiresAt",
                  "startedAt", "completedAt", "createdAt", "updatedAt"`,
      [runId, TenantProvisioningState.SUCCEEDED, leaseToken],
    );
    if (rows.length === 0) {
      throw new Error('Provisioning lease lost before marking run succeeded');
    }
  }

  private async markRunWaiting(
    runId: string,
    error: ProvisioningWaitPendingError,
    leaseToken?: string | null,
  ): Promise<void> {
    const rows = await this.queryRows<TenantProvisioningRunRow>(
      `UPDATE admin.tenant_provisioning_runs
          SET state = $2,
              "lastError" = $3,
              attempts = GREATEST(attempts - 1, 0),
              "nextRetryAt" = now() + ($5::text)::interval,
              "leaseToken" = NULL,
              "leasedBy" = NULL,
              "heartbeatAt" = NULL,
              "leaseExpiresAt" = NULL,
              "updatedAt" = now()
        WHERE id = $1
          AND ($4::uuid IS NULL OR "leaseToken" = $4::uuid)
        RETURNING id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
                  "actorUserId", state, "currentStep", "lastError", attempts,
                  "nextRetryAt", "leaseToken", "leasedBy", "heartbeatAt", "leaseExpiresAt",
                  "startedAt", "completedAt", "createdAt", "updatedAt"`,
      [
        runId,
        TenantProvisioningState.QUEUED,
        error.message,
        leaseToken ?? null,
        `${error.retryMs} milliseconds`,
      ],
    );

    if (rows.length === 0) {
      this.logger.warn(
        `Skipping db-migrate wait requeue for operation ${runId} because this worker no longer holds the lease`,
      );
      return;
    }

    await this.queryRows(
      `UPDATE admin.tenant_provisioning_steps
          SET state = $3,
              "lastError" = $4,
              "completedAt" = NULL,
              "updatedAt" = now()
        WHERE "runId" = $1 AND "stepName" = $2`,
      [runId, error.stepName, TenantProvisioningState.QUEUED, error.message],
    );

    this.logger.log(`Tenant provisioning operation ${runId} is waiting at ${error.stepName}`);
  }

  private async markRunFailed(
    runId: string,
    error: unknown,
    leaseToken?: string | null,
  ): Promise<boolean> {
    this.metrics.recordRunTerminal(TenantProvisioningState.FAILED);
    const run = await this.getRun(runId);
    const rows = await this.queryRows<TenantProvisioningRunRow>(
      `UPDATE admin.tenant_provisioning_runs
          SET state = $2,
              "lastError" = $3,
              "leaseToken" = NULL,
              "leasedBy" = NULL,
              "heartbeatAt" = NULL,
              "leaseExpiresAt" = NULL,
              "completedAt" = now(),
              "updatedAt" = now()
        WHERE id = $1
          AND ($4::uuid IS NULL OR "leaseToken" = $4::uuid)
        RETURNING id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
                  "actorUserId", state, "currentStep", "lastError", attempts,
                  "nextRetryAt", "leaseToken", "leasedBy", "heartbeatAt", "leaseExpiresAt",
                  "startedAt", "completedAt", "createdAt", "updatedAt"`,
      [runId, TenantProvisioningState.FAILED, this.errorMessage(error), leaseToken ?? null],
    );
    if (rows.length === 0) {
      return false;
    }

    if (run) {
      await this.authProvisioningClient.failProvisioning({
        ...this.buildAuthCommandMetadata(
          'FailProvisioning',
          run.id,
          run.tenantId,
          run.idempotencyKey,
          run.requestHash,
          run.actorUserId,
          { error: this.errorMessage(error) },
        ),
        reason: this.errorMessage(error),
      });
    }

    return true;
  }

  private async publishFailure(run: TenantProvisioningRunRow, error: unknown): Promise<void> {
    const message = this.errorMessage(error);
    this.logger.error(`Tenant provisioning operation ${run.id} failed: ${message}`);

    await this.enqueueEvent(
      {
        ...createBaseEvent('TenantProvisioningFailed', run.tenantId, {
          aggregateId: run.tenantId,
          aggregateType: 'Tenant',
          version: 4,
        }),
        operationId: run.id,
        error: message,
        currentStep: run.currentStep ?? undefined,
        attempt: run.attempts,
      },
      'tenant-provisioning-failed:' + run.id + ':' + run.attempts,
    );
  }

  private async requeueStaleRuns(): Promise<void> {
    const retryRows = await this.queryRows<TenantProvisioningRunRow>(
      `UPDATE admin.tenant_provisioning_runs
          SET state = $2,
              "lastError" = 'Operation recovered after worker interruption',
              "leaseToken" = NULL,
              "leasedBy" = NULL,
              "heartbeatAt" = NULL,
              "leaseExpiresAt" = NULL,
              "updatedAt" = now()
        WHERE state = $1
          AND "leaseExpiresAt" < now()
          AND attempts < $3
        RETURNING id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
                  "actorUserId", state, "currentStep", "lastError", attempts,
                  "nextRetryAt", "leaseToken", "leasedBy", "heartbeatAt", "leaseExpiresAt",
                  "startedAt", "completedAt", "createdAt", "updatedAt"`,
      [TenantProvisioningState.RUNNING, TenantProvisioningState.QUEUED, MAX_OPERATION_ATTEMPTS],
    );

    const failedRows = await this.queryRows<TenantProvisioningRunRow>(
      `UPDATE admin.tenant_provisioning_runs
          SET state = $2,
              "lastError" = 'Operation exceeded max attempts after worker interruption',
              "leaseToken" = NULL,
              "leasedBy" = NULL,
              "heartbeatAt" = NULL,
              "leaseExpiresAt" = NULL,
              "completedAt" = now(),
              "updatedAt" = now()
        WHERE state = $1
          AND "leaseExpiresAt" < now()
          AND attempts >= $3
        RETURNING id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
                  "actorUserId", state, "currentStep", "lastError", attempts,
                  "nextRetryAt", "leaseToken", "leasedBy", "heartbeatAt", "leaseExpiresAt",
                  "startedAt", "completedAt", "createdAt", "updatedAt"`,
      [TenantProvisioningState.RUNNING, TenantProvisioningState.FAILED, MAX_OPERATION_ATTEMPTS],
    );

    for (const run of failedRows) {
      await this.authProvisioningClient.failProvisioning({
        ...this.buildAuthCommandMetadata(
          'FailProvisioning',
          run.id,
          run.tenantId,
          run.idempotencyKey,
          run.requestHash,
          run.actorUserId,
          { error: run.lastError ?? 'Operation exceeded max attempts after worker interruption' },
        ),
        reason: run.lastError ?? 'Operation exceeded max attempts after worker interruption',
      });
      await this.publishFailure(
        run,
        run.lastError ?? 'Operation exceeded max attempts after worker interruption',
      );
    }

    if (retryRows.length > 0 || failedRows.length > 0) {
      this.logger.warn(
        `Recovered stale tenant provisioning runs: requeued=${retryRows.length}, failed=${failedRows.length}`,
      );
    }
  }

  private async getRun(operationId: string): Promise<TenantProvisioningRunRow | null> {
    const rows = await this.queryRows<TenantProvisioningRunRow>(
      `SELECT id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
              "actorUserId", state, "currentStep", "lastError", attempts,
              "nextRetryAt", "leaseToken", "leasedBy", "heartbeatAt", "leaseExpiresAt",
              "startedAt", "completedAt", "createdAt", "updatedAt"
         FROM admin.tenant_provisioning_runs
        WHERE id = $1`,
      [operationId],
    );
    return rows[0] ?? null;
  }

  private async getRunSteps(operationId: string): Promise<TenantProvisioningStepDto[]> {
    return this.toStepDtos(
      await this.queryRows<TenantProvisioningStepRow>(PROVISIONING_STEP_SELECT_SQL, [operationId]),
    );
  }

  private async getRunStepsInTransaction(
    manager: EntityManager,
    operationId: string,
  ): Promise<TenantProvisioningStepDto[]> {
    return this.toStepDtos(
      await this.managerRows<TenantProvisioningStepRow>(manager, PROVISIONING_STEP_SELECT_SQL, [
        operationId,
      ]),
    );
  }

  private toStepDtos(rows: TenantProvisioningStepRow[]): TenantProvisioningStepDto[] {
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
    steps: TenantProvisioningStepDto[] = [],
  ): CreateTenantAcceptedResponse {
    return {
      status: run.state,
      tenantStatus: tenant?.status ?? TenantStatus.PENDING,
      statusUrl: `/tenants/provisioning/${run.id}`,
      retryAfterMs: this.retryAfterMs(run.state),
      availableActions: this.availableActions(run.state),
      // The step rows were already fetched on every poll and thrown away; an
      // operator needs the failing step and its lastError, not just "FAILED".
      steps,
    };
  }

  private retryAfterMs(state: TenantProvisioningState): number {
    switch (state) {
      case TenantProvisioningState.QUEUED:
      case TenantProvisioningState.RESERVING:
      case TenantProvisioningState.RUNNING:
        return 2_000;
      default:
        return 0;
    }
  }

  private availableActions(state: TenantProvisioningState): string[] {
    if (state === TenantProvisioningState.FAILED) {
      return ['retryProvisioning'];
    }
    return [];
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async queryRows<T extends object>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result: unknown = await this.dataSource.query(sql, params);
    return queryRowsNormalized<T>(result);
  }

  private async managerRows<T extends object>(
    manager: EntityManager,
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result: unknown = await manager.query(sql, params);
    return queryRowsNormalized<T>(result);
  }
}
