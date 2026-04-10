import { Injectable, ConflictException, Logger, Inject } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { IEventBus } from '@platform/event-bus';

import { TenantCreatedEvent } from '@platform/event-contracts';

import { AuditLogService } from '../../audit/audit.service';
import { PlanTier, BillingCycle } from '../../billing/entities/plan-definition.entity';
import { ModuleAssignmentService } from '../../modules/tenant-management/services/module-assignment.service';
import { CreateTenantCommand } from '../commands/tenant.commands';
import { Tenant, TenantStatus, TenantTier } from '../entities/tenant.entity';
import { TenantProvisioningService } from '../services/tenant-provisioning.service';

@Injectable()
@CommandHandler(CreateTenantCommand)
export class CreateTenantHandler
  implements ICommandHandler<CreateTenantCommand, Tenant>
{
  private readonly logger = new Logger(CreateTenantHandler.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
    private readonly auditLogService: AuditLogService,
    private readonly provisioningService: TenantProvisioningService,
    private readonly moduleAssignmentService: ModuleAssignmentService,
  ) {}

  async execute(command: CreateTenantCommand): Promise<Tenant> {
    const { data, createdBy } = command;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Check for duplicate slug if provided
      if (data.slug) {
        const existingBySlug = await queryRunner.manager.findOne(Tenant, {
          where: { slug: data.slug },
          lock: { mode: 'pessimistic_read' },
        });

        if (existingBySlug) {
          throw new ConflictException(
            `Tenant with slug '${data.slug}' already exists`,
          );
        }
      }

      // Check for duplicate domain if provided
      if (data.domain) {
        const existingByDomain = await queryRunner.manager.findOne(Tenant, {
          where: { domain: data.domain },
          lock: { mode: 'pessimistic_read' },
        });

        if (existingByDomain) {
          throw new ConflictException(
            `Tenant with domain '${data.domain}' already exists`,
          );
        }
      }

      // Create tenant
      const tenant = queryRunner.manager.create(Tenant, {
        name: data.name,
        slug: data.slug,
        description: data.description,
        domain: data.domain,
        tier: data.tier || TenantTier.STARTER,
        status: TenantStatus.PENDING,
        primaryContact: data.primaryContact,
        billingContact: data.billingContact,
        billingEmail: data.billingEmail,
        country: data.country,
        region: data.region,
        createdBy,
        userCount: 0,
        farmCount: 0,
        sensorCount: 0,
      });

      // Set trial end date if specified
      if (data.trialDays && data.trialDays > 0) {
        tenant.trialEndsAt = new Date(
          Date.now() + data.trialDays * 24 * 60 * 60 * 1000,
        );
      }

      const savedTenant = await queryRunner.manager.save(tenant);

      await queryRunner.commitTransaction();

      this.logger.log(
        `Tenant created: ${savedTenant.id} (${savedTenant.slug}) by ${createdBy}`,
      );

      // Audit log
      await this.auditLogService.log({
        action: 'TENANT_CREATED',
        entityType: 'tenant',
        entityId: savedTenant.id,
        performedBy: createdBy,
        details: {
          name: savedTenant.name,
          slug: savedTenant.slug,
          tier: savedTenant.tier,
        },
      });

      // Publish domain event — flat object conforming to TenantCreatedEvent.
      // Billing-relevant fields (tier, moduleIds) are carried by
      // TenantSubscriptionRequestedEvent published later in the flow.
      const tenantCreatedEvent: TenantCreatedEvent = {
        eventId: crypto.randomUUID(),
        eventType: 'TenantCreated',
        timestamp: new Date().toISOString(),
        tenantId: savedTenant.id,
        slug: savedTenant.slug,
        name: savedTenant.name,
        version: 1,
      };
      await this.eventBus.publish(tenantCreatedEvent);

      // SYNCHRONOUS provisioning - schema MUST exist before tenant is usable
      // This ensures tenant data isolation is set up before returning
      // Schema creation must ALWAYS run, admin user creation only if email provided
      const adminEmail = data.primaryContact?.email || data.contactEmail;

      // ALWAYS run provisioning - schema is required for tenant to work
      this.logger.log(`Starting SYNCHRONOUS provisioning for tenant ${savedTenant.id}`);
      const provisionStartTime = Date.now();

      try {
        // Step 1: Assign modules with pricing BEFORE provisioning.
        // This is the single, authoritative module assignment point.
        // createTenantSchema() queries auth.tenant_modules to determine
        // which module tables to create — so modules must exist first.
        if (data.moduleIds && data.moduleIds.length > 0) {
          await this.assignModulesWithPricing(savedTenant, data, createdBy);
        }

        // Step 2: Provision tenant (create schema, roles, config, optionally create admin)
        // Note: assignModules is omitted — modules were already assigned above
        // and createTenantSchema queries auth.tenant_modules directly.
        const provisionResult = await this.provisioningService.provisionTenant(
          savedTenant.id,
          {
            createFirstAdmin: !!adminEmail,  // Only create admin if email exists
            adminEmail: adminEmail || undefined,
            adminFirstName: data.primaryContact?.name?.split(' ')[0] || 'Admin',
            adminLastName: data.primaryContact?.name?.split(' ').slice(1).join(' ') || 'User',
          },
        );

        const provisionDuration = Date.now() - provisionStartTime;

        if (provisionResult.success) {
          this.logger.log(
            `Tenant ${savedTenant.id} provisioned successfully in ${provisionDuration}ms`,
          );

          if (provisionResult.adminUser) {
            this.logger.log(`Admin user created: ${provisionResult.adminUser.email}`);
          }

          // Step 3: Create subscription for billing via NATS
          await this.createTenantSubscription(savedTenant, data, createdBy);

        } else {
          // Provisioning failed - tenant remains PENDING
          this.logger.error(
            `Tenant ${savedTenant.id} provisioning failed: ${provisionResult.error}`,
            { steps: provisionResult.steps, duration: provisionDuration },
          );

          // Emit failure event for monitoring/alerting (flat-object pattern)
          const failedStep = provisionResult.steps?.find((s) => s.status === 'failed');
          const completedCount = provisionResult.steps?.filter((s) => s.status === 'completed').length ?? 0;
          await this.eventBus.publish({
            eventId: crypto.randomUUID(),
            eventType: 'TenantProvisioningFailed',
            timestamp: new Date().toISOString(),
            tenantId: savedTenant.id,
            error: provisionResult.error,
            stepCount: provisionResult.steps?.length ?? 0,
            durationMs: provisionDuration,
            failedStepName: failedStep?.name,
            failedStepError: failedStep?.error,
            failedStepIndex: failedStep ? provisionResult.steps?.indexOf(failedStep) : undefined,
            completedStepCount: completedCount,
            version: 3,
          });
        }

      } catch (err) {
        const provisionDuration = Date.now() - provisionStartTime;
        this.logger.error(
          `Provisioning exception for ${savedTenant.id}: ${(err as Error).message}`,
          { duration: provisionDuration, stack: (err as Error).stack },
        );

        // Tenant remains in PENDING status - manual intervention may be needed
        // Don't throw - tenant record is valid, just not provisioned
      }

      return savedTenant;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to create tenant: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Assign modules to tenant with pricing calculation
   */
  private async assignModulesWithPricing(
    tenant: Tenant,
    data: CreateTenantCommand['data'],
    assignedBy: string,
  ): Promise<void> {
    try {
      // Build module assignment request with quantities
      const modules = (data.moduleIds || []).map((moduleId) => {
        const quantityConfig = data.moduleQuantities?.find(
          (q) => q.moduleId === moduleId,
        );
        return {
          moduleId,
          quantities: quantityConfig
            ? {
                users: quantityConfig.users,
                farms: quantityConfig.farms,
                ponds: quantityConfig.ponds,
                sensors: quantityConfig.sensors,
                employees: quantityConfig.employees,
              }
            : {
                users: 5, // Default quantities
                farms: 1,
                ponds: 10,
                sensors: 5,
              },
        };
      });

      // Map tenant tier to plan tier
      const tierMap: Record<string, PlanTier> = {
        starter: PlanTier.STARTER,
        professional: PlanTier.PROFESSIONAL,
        enterprise: PlanTier.ENTERPRISE,
      };
      const planTier = tierMap[tenant.tier?.toLowerCase() || 'starter'] || PlanTier.STARTER;

      // Map billing cycle
      const cycleMap: Record<string, BillingCycle> = {
        monthly: BillingCycle.MONTHLY,
        quarterly: BillingCycle.QUARTERLY,
        semi_annual: BillingCycle.SEMI_ANNUAL,
        annual: BillingCycle.ANNUAL,
      };
      const billingCycle = cycleMap[data.billingCycle || 'monthly'] || BillingCycle.MONTHLY;

      const result = await this.moduleAssignmentService.assignModulesToTenant({
        tenantId: tenant.id,
        modules,
        assignedBy,
        tier: planTier,
        billingCycle,
      });

      if (result.success) {
        this.logger.log(
          `Assigned ${result.assignedModules.length} modules to tenant ${tenant.id}. Monthly price: $${result.totalMonthlyPrice}`,
        );
      } else {
        this.logger.warn(
          `Some modules failed to assign: ${result.failedModules.map((f) => f.moduleId).join(', ')}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to assign modules to tenant ${tenant.id}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Create subscription event for billing service
   */
  private async createTenantSubscription(
    tenant: Tenant,
    data: CreateTenantCommand['data'],
    createdBy: string,
  ): Promise<void> {
    try {
      // Map tenant tier to plan tier
      const tierMap: Record<string, PlanTier> = {
        starter: PlanTier.STARTER,
        professional: PlanTier.PROFESSIONAL,
        enterprise: PlanTier.ENTERPRISE,
      };
      const planTier = tierMap[tenant.tier?.toLowerCase() || 'starter'] || PlanTier.STARTER;

      // Publish subscription requested event for billing service via NATS
      await this.eventBus.publish({
        eventId: crypto.randomUUID(),
        eventType: 'TenantSubscriptionRequested',
        timestamp: new Date().toISOString(),
        tenantId: tenant.id,
        tenantName: tenant.name,
        moduleIds: data.moduleIds || [],
        moduleQuantities: data.moduleQuantities,
        trialDays: data.trialDays,
        tier: planTier,
        billingCycle: data.billingCycle || 'monthly',
        billingEmail: data.billingEmail || data.primaryContact?.email,
        createdBy,
        version: 1,
      });

      this.logger.log(`Subscription event published for tenant ${tenant.id}`);
    } catch (error) {
      this.logger.error(
        `Failed to publish subscription event for tenant ${tenant.id}: ${(error as Error).message}`,
      );
    }
  }
}
