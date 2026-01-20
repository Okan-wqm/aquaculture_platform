import { Injectable, ConflictException, Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner } from 'typeorm';
import { CreateTenantCommand } from '../commands/tenant.commands';
import { Tenant, TenantStatus, TenantTier } from '../entities/tenant.entity';
import { AuditLogService } from '../../audit/audit.service';
import { TenantProvisioningService } from '../services/tenant-provisioning.service';
import { ModuleAssignmentService } from '../../modules/tenant-management/services/module-assignment.service';
import { PlanTier, BillingCycle } from '../../billing/entities/plan-definition.entity';

@Injectable()
@CommandHandler(CreateTenantCommand)
export class CreateTenantHandler
  implements ICommandHandler<CreateTenantCommand, Tenant>
{
  private readonly logger = new Logger(CreateTenantHandler.name);

  constructor(
    @InjectRepository(Tenant)
    _tenantRepository: Repository<Tenant>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly eventBus: EventBus,
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

      // Publish domain event
      this.eventBus.publish({
        eventType: 'TenantCreated',
        payload: {
          tenantId: savedTenant.id,
          slug: savedTenant.slug,
          name: savedTenant.name,
          tier: savedTenant.tier,
          moduleIds: data.moduleIds,
          createdBy,
        },
        timestamp: new Date(),
      });

      // SYNCHRONOUS provisioning - schema MUST exist before tenant is usable
      // This ensures tenant data isolation is set up before returning
      // Schema creation must ALWAYS run, admin user creation only if email provided
      const adminEmail = data.primaryContact?.email || data.contactEmail;

      // ALWAYS run provisioning - schema is required for tenant to work
      this.logger.log(`Starting SYNCHRONOUS provisioning for tenant ${savedTenant.id}`);
      const provisionStartTime = Date.now();

      try {
        // Step 1: Provision tenant (create schema, optionally create admin)
        const provisionResult = await this.provisioningService.provisionTenant(
          savedTenant.id,
          {
            createFirstAdmin: !!adminEmail,  // Only create admin if email exists
            adminEmail: adminEmail || undefined,
            adminFirstName: data.primaryContact?.name?.split(' ')[0] || 'Admin',
            adminLastName: data.primaryContact?.name?.split(' ').slice(1).join(' ') || 'User',
            assignModules: data.moduleIds || [],
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

          // Step 2: Assign modules with pricing if moduleIds provided
          if (data.moduleIds && data.moduleIds.length > 0) {
            await this.assignModulesWithPricing(savedTenant, data, createdBy);
          }

          // Step 3: Create subscription for billing
          await this.createTenantSubscription(savedTenant, data, createdBy);

        } else {
          // Provisioning failed - tenant remains PENDING
          this.logger.error(
            `Tenant ${savedTenant.id} provisioning failed: ${provisionResult.error}`,
            { steps: provisionResult.steps, duration: provisionDuration },
          );

          // Emit failure event for monitoring/alerting
          this.eventBus.publish({
            eventType: 'TenantProvisioningFailed',
            payload: {
              tenantId: savedTenant.id,
              error: provisionResult.error,
              steps: provisionResult.steps,
              duration: provisionDuration,
            },
            timestamp: new Date(),
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

      // Publish subscription requested event for billing service
      this.eventBus.publish({
        eventType: 'TenantSubscriptionRequested',
        payload: {
          tenantId: tenant.id,
          tenantName: tenant.name,
          moduleIds: data.moduleIds || [],
          moduleQuantities: data.moduleQuantities,
          trialDays: data.trialDays,
          tier: planTier,
          billingCycle: data.billingCycle || 'monthly',
          billingEmail: data.billingEmail || data.primaryContact?.email,
          createdBy,
        },
        timestamp: new Date(),
      });

      this.logger.log(`Subscription event published for tenant ${tenant.id}`);
    } catch (error) {
      this.logger.error(
        `Failed to publish subscription event for tenant ${tenant.id}: ${(error as Error).message}`,
      );
    }
  }
}
