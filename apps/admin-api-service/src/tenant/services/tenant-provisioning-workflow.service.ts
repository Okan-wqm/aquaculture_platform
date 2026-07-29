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
  type BaseEvent,
  type BillingCycle as BillingCommandBillingCycle,
  type PlanTier as BillingCommandPlanTier,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, EntityManager } from 'typeorm';

import { AuditLogService } from '../../audit/audit.service';
import { AuditAction } from '../../audit/audit.entity';
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
import { TenantProvisioningService } from './tenant-provisioning.service';

/**
 * What reconciling a tenant's subscription found or repaired.
 *
 * Every field but `tenantId` is optional because the reconciliation reports what
 * it OBSERVED: a tenant with no subscription yields a tenant id and nothing
 * else, and `replayed` appears only when the workflow actually re-emitted the
 * provisioning command. Absent means "not applicable", which is a different
 * statement from zero.
 */
export interface TenantSubscriptionReconciliation {
  tenantId: string;
  subscriptionId?: string;
  status?: string;
  moduleItemCount?: number;
  replayed?: boolean;
}

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
// Onboarding-ack wait (APA-022): a not-yet-arrived ack requeues every
// ONBOARDING_ACK_RETRY_MS until the deadline, then terminally fails while the
// tenant is still PROVISIONING (never ACTIVE).
const ONBOARDING_ACK_RETRY_MS = 15 * 1000;
// Wall-clock deadline default (env override: TENANT_ONBOARDING_ACK_TIMEOUT_MS).
// NOTE on the effective bound: a crashed/stalled worker's deadline cannot be
// enforced faster than OPERATION_LEASE_MS (the lease TTL requeueStaleRuns waits
// on), so a stuck run's worst-case terminal latency is ~max(deadline, lease).
const ONBOARDING_ACK_DEADLINE_MS = 10 * 60 * 1000;

// APA-022/APA-024: begin_provisioning is now catalogued (it always executed 2nd
// but was absent, so it sorted last via the removed 999 fallback). The
// onboarding-ack barrier (wait_for_onboarding_ack) is ordered BEFORE the
// user-visible commitments (create_subscription, activate_tenant): a terminal
// failure at or before the barrier therefore fires against a still-PROVISIONING
// tenant — a legal PROVISIONING→PROVISIONING_FAILED transition — instead of
// leaving a FAILED run coexisting with an ACTIVE tenant + live subscription.
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

/**
 * Generic "this step is not done yet — requeue and try again later" signal.
 * Generalises the former db-migrate-only wait: it carries the step to requeue
 * and its backoff so the catch site (processOperation) is fully data-driven.
 */
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
        await queryRunner.commitTransaction();
        return this.toAcceptedResponse(existingRun, responseTenant);
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

      await queryRunner.commitTransaction();
      return this.toAcceptedResponse(run, this.hydrateCreatedTenant(tenantDraft, payload));
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
                "updatedAt" = now()
          WHERE id = $1
          RETURNING id, "tenantId", "idempotencyKey", "requestHash", "requestPayload",
                    "actorUserId", state, "currentStep", "lastError", attempts,
                    "nextRetryAt", "leaseToken", "leasedBy", "heartbeatAt", "leaseExpiresAt",
                    "startedAt", "completedAt", "createdAt", "updatedAt"`,
        [operationId, TenantProvisioningState.QUEUED],
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

      // APA-022: clear the run's onboarding-ack rows and re-arm the (already
      // SUCCEEDED) onboarding-request step so a retried run does not instantly
      // re-read a stale FAILED ack row and terminal-fail identically. This
      // resets the local barrier state; re-delivery to owner services past the
      // outbox idempotency key is a tracked follow-on (ADMIN-MEDIUM-004) and
      // out of this change's scope.
      await this.managerRows(
        manager,
        `DELETE FROM admin.tenant_onboarding_acks WHERE "operationId" = $1`,
        [operationId],
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
          WHERE "runId" = $1 AND "stepName" = 'publish_onboarding_requested'`,
        [operationId, TenantProvisioningState.QUEUED],
      );

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
          action: AuditAction.TENANT_CREATE_REQUESTED,
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

      // APA-022: request onboarding and BLOCK on the owner-service acks BEFORE
      // any user-visible commitment. create_subscription/activate_tenant run
      // only after every required owner service has acked.
      await this.runStep(run.id, leaseToken, 'publish_onboarding_requested', async () => {
        await this.enqueueEvent(
          {
            ...createBaseEvent('TenantOnboardingRequested', tenant.id, {
              aggregateId: tenant.id,
              aggregateType: 'Tenant',
            }),
            operationId: run.id,
            slug: tenant.slug,
            name: tenant.name,
            moduleIds: payload.moduleIds,
          },
          'tenant-onboarding-requested:' + run.id,
        );
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

      // APA-022: post-activation announce steps are BEST-EFFORT. The tenant is
      // already committed ACTIVE with a live subscription; a transient throw
      // here must NOT flip the run to FAILED — that would recreate the
      // FAILED-but-ACTIVE contradiction the reorder eliminates. Both writes are
      // append-only/idempotent and self-heal (audit backfill / outbox relay).
      await this.runStep(run.id, leaseToken, 'audit_provisioned', async () => {
        try {
          await this.auditLogService.log({
            action: AuditAction.TENANT_PROVISIONED,
            entityType: 'tenant',
            entityId: tenant.id,
            performedBy: run.actorUserId,
            details: {
              operationId: run.id,
              moduleIds: payload.moduleIds,
              tenantStatus: TenantStatus.ACTIVE,
            },
          });
        } catch (auditError) {
          this.logger.error(
            `audit_provisioned (best-effort) failed for operation ${run.id}; tenant is already ACTIVE: ${(auditError as Error).message}`,
          );
        }
      });

      await this.runStep(run.id, leaseToken, 'publish_tenant_provisioned', async () => {
        try {
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
        } catch (publishError) {
          this.logger.error(
            `publish_tenant_provisioned (best-effort) failed for operation ${run.id}; tenant is already ACTIVE: ${(publishError as Error).message}`,
          );
        }
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
    if (trimmed && trimmed.length >= 16 && trimmed.length <= 128) return trimmed;

    throw new BadRequestException(
      'Idempotency-Key is required for tenant creation and must be 16-128 characters',
    );
  }

  private hashPayload(payload: CreateTenantDto): string {
    return crypto.createHash('sha256').update(this.stableStringify(payload)).digest('hex');
  }

  private async assertTenantOnboardingAcks(operationId: string): Promise<void> {
    const requiredServices = this.requiredOnboardingServices();

    const rows = await this.queryRows<{
      service: string;
      status: 'ACK' | 'FAILED';
      error: string | null;
    }>(
      `SELECT service, status, error
         FROM admin.tenant_onboarding_acks
        WHERE "operationId" = $1`,
      [operationId],
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

    // APA-022: a not-yet-arrived ack is NOT a terminal failure — requeue until a
    // deadline, then fail terminally while the tenant is still PROVISIONING.
    // Elapsed time is computed on the DATABASE clock (the same clock that
    // stamped the wait step's startedAt), not the app clock: this avoids
    // app/DB skew and the NaN-from-ISO-string livelock an app-side
    // `Date.now() - startedAt` would produce (which would requeue forever and
    // silently defeat the deadline).
    const elapsedRows = await this.queryRows<{ elapsed_ms: string | number | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - "startedAt")) * 1000 AS elapsed_ms
         FROM admin.tenant_provisioning_steps
        WHERE "runId" = $1 AND "stepName" = 'wait_for_onboarding_ack'
        LIMIT 1`,
      [operationId],
    );
    const elapsedMs = Number(elapsedRows[0]?.elapsed_ms ?? 0);
    const deadlineMs = this.onboardingAckDeadlineMs();
    const missingMessage = `Tenant onboarding ack missing from owner services: ${missing.join(', ')}`;
    if (Number.isFinite(elapsedMs) && elapsedMs >= deadlineMs) {
      throw new Error(
        `${missingMessage} — onboarding-ack deadline of ${deadlineMs}ms exceeded (waited ${Math.round(elapsedMs)}ms). Failing provisioning while the tenant is still PROVISIONING.`,
      );
    }
    throw new ProvisioningWaitPendingError(
      'wait_for_onboarding_ack',
      ONBOARDING_ACK_RETRY_MS,
      missingMessage,
    );
  }

  private requiredOnboardingServices(): string[] {
    return (process.env['TENANT_ONBOARDING_REQUIRED_SERVICES'] ?? 'farm-service')
      .split(',')
      .map((service) => service.trim())
      .filter((service) => service.length > 0);
  }

  private onboardingAckDeadlineMs(): number {
    const raw = process.env['TENANT_ONBOARDING_ACK_TIMEOUT_MS'];
    const parsed = raw !== undefined ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : ONBOARDING_ACK_DEADLINE_MS;
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
  ): Promise<TenantSubscriptionReconciliation> {
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

    this.logger.log(
      `db-migrate tenant schema ledger confirmed for tenant ${tenantId}: ${schemaRow.schemaName}`,
    );
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

  private async activateTenantAfterVerification(
    run: TenantProvisioningRunRow,
    tenantId: string,
  ): Promise<void> {
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
    // begin_provisioning is now catalogued, so indexOf can never be -1 and the
    // 999 fallback is gone — an uncatalogued step name is a compile error.
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
          uuid_generate_v4(), $1, $2, $4, $3, 1, now(), now(), now()
        )
        ON CONFLICT ("runId", "stepName")
        DO UPDATE SET
          state = $3,
          attempts = admin.tenant_provisioning_steps.attempts + 1,
          -- APA-022: preserve the FIRST attempt time so a step-scoped deadline
          -- (onboarding-ack wait) survives cron requeues; retryOperation resets
          -- it to NULL for a fresh clock.
          "startedAt" = COALESCE(admin.tenant_provisioning_steps."startedAt", now()),
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

    try {
      await work();
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
        `Skipping ${error.stepName} wait requeue for operation ${runId} because this worker no longer holds the lease`,
      );
      return;
    }

    // Reset the waiting step to QUEUED but leave "startedAt" untouched so a
    // deadline anchored on the step's first-attempt time survives requeues.
    await this.queryRows(
      `UPDATE admin.tenant_provisioning_steps
          SET state = $3,
              "lastError" = $4,
              "completedAt" = NULL,
              "updatedAt" = now()
        WHERE "runId" = $1 AND "stepName" = $2`,
      [runId, error.stepName, TenantProvisioningState.QUEUED, error.message],
    );

    this.logger.log(
      `Tenant provisioning operation ${runId} is waiting at step ${error.stepName} (retry in ${error.retryMs}ms)`,
    );
  }

  private async markRunFailed(
    runId: string,
    error: unknown,
    leaseToken?: string | null,
  ): Promise<boolean> {
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
    const rows = await this.queryRows<TenantProvisioningStepRow>(
      `SELECT "stepName", state, "stepOrder", attempts, "lastError", "startedAt", "completedAt"
         FROM admin.tenant_provisioning_steps
        WHERE "runId" = $1
        ORDER BY "stepOrder" ASC, "createdAt" ASC`,
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
    _steps?: TenantProvisioningStepDto[],
  ): CreateTenantAcceptedResponse {
    return {
      status: run.state,
      tenantStatus: tenant?.status ?? TenantStatus.PENDING,
      statusUrl: `/tenants/provisioning/${run.id}`,
      retryAfterMs: this.retryAfterMs(run.state),
      availableActions: this.availableActions(run.state),
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
