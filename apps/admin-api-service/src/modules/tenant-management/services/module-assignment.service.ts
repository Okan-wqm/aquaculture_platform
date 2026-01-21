import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EventBus } from '@nestjs/cqrs';
import {
  PricingCalculatorService,
  ModuleSelection,
  PricingCalculation,
} from '../../../billing/services/pricing-calculator.service';
import { PlanTier, BillingCycle } from '../../../billing/entities/plan-definition.entity';

/**
 * Module quantities for pricing calculation
 */
export interface ModuleQuantities {
  users?: number;
  farms?: number;
  ponds?: number;
  sensors?: number;
  employees?: number;
  storageGb?: number;
  apiCalls?: number;
  alerts?: number;
  reports?: number;
  integrations?: number;
  devices?: number;
}

/**
 * Single module assignment request
 */
export interface ModuleAssignmentDto {
  tenantId: string;
  moduleId: string;
  quantities?: ModuleQuantities;
  expiresAt?: Date;
  assignedBy: string;
}

/**
 * Bulk module assignment request
 */
export interface BulkModuleAssignmentDto {
  tenantId: string;
  modules: Array<{
    moduleId: string;
    moduleCode?: string;
    quantities?: ModuleQuantities;
  }>;
  assignedBy: string;
  tier?: PlanTier;
  billingCycle?: BillingCycle;
}

/**
 * Result of module assignment operation
 */
export interface ModuleAssignmentResult {
  success: boolean;
  tenantId: string;
  assignedModules: string[];
  failedModules: Array<{ moduleId: string; error: string }>;
  pricing?: PricingCalculation;
  totalMonthlyPrice: number;
}

/**
 * Tenant module with pricing information
 */
export interface TenantModuleWithPricing {
  id: string;
  tenantId: string;
  moduleId: string;
  moduleCode: string;
  moduleName: string;
  moduleDescription?: string;
  moduleIcon?: string;
  isActive: boolean;
  assignedAt: Date;
  expiresAt?: Date;
  quantities: ModuleQuantities;
  monthlyPrice: number;
  configuration: Record<string, unknown>;
}

/**
 * Module info from database
 */
interface ModuleInfo {
  id: string;
  code: string;
  name: string;
  description?: string;
  icon?: string;
}

/**
 * Module Assignment Service
 *
 * Handles assigning and removing modules from tenants with:
 * - Pricing calculation integration
 * - Event publishing for billing sync
 * - Audit trail
 */
@Injectable()
export class ModuleAssignmentService {
  private readonly logger = new Logger(ModuleAssignmentService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly eventBus: EventBus,
    private readonly pricingCalculator: PricingCalculatorService,
  ) {}

  /**
   * Assign multiple modules to a tenant
   */
  async assignModulesToTenant(
    dto: BulkModuleAssignmentDto,
  ): Promise<ModuleAssignmentResult> {
    const { tenantId, modules, assignedBy, tier = PlanTier.STARTER, billingCycle = BillingCycle.MONTHLY } = dto;

    this.logger.log(
      `Assigning ${modules.length} modules to tenant ${tenantId}`,
    );

    // Validate tenant exists
    const tenant = await this.getTenant(tenantId);
    if (!tenant) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }

    const assignedModules: string[] = [];
    const failedModules: Array<{ moduleId: string; error: string }> = [];

    // Get module information for all requested modules
    const moduleInfoMap = await this.getModuleInfoMap(
      modules.map((m) => m.moduleId),
    );

    // Prepare modules for pricing calculation
    const moduleSelections: ModuleSelection[] = [];

    // Process each module within a transaction for atomicity
    await this.dataSource.transaction(async (manager) => {
      for (const moduleRequest of modules) {
        const { moduleId, quantities = {} } = moduleRequest;

        try {
          const moduleInfo = moduleInfoMap.get(moduleId);
          if (!moduleInfo) {
            failedModules.push({
              moduleId,
              error: `Module ${moduleId} not found`,
            });
            continue;
          }

          // Check if already assigned
          const existingResult = await manager.query(
            `SELECT EXISTS(
              SELECT 1 FROM tenant_modules
              WHERE tenant_id = $1 AND module_id = $2 AND is_active = true
            ) as exists`,
            [tenantId, moduleId],
          );
          const existing = existingResult[0]?.exists === true ||
                          existingResult[0]?.exists === 't' ||
                          existingResult[0]?.exists === 'true';

          if (existing) {
            // Update quantities instead of failing
            await manager.query(
              `UPDATE tenant_modules
               SET quantities = $3, updated_at = NOW(), assigned_by = $4
               WHERE tenant_id = $1 AND module_id = $2`,
              [tenantId, moduleId, JSON.stringify(quantities), assignedBy],
            );
            assignedModules.push(moduleId);
            this.logger.log(`Updated quantities for module ${moduleId} on tenant ${tenantId}`);
          } else {
            // Insert new assignment
            await manager.query(
              `INSERT INTO tenant_modules (
                id, tenant_id, module_id, is_active, assigned_at,
                assigned_by, quantities, created_at, updated_at
              ) VALUES (
                gen_random_uuid(), $1, $2, true, NOW(), $3, $4, NOW(), NOW()
              )
              ON CONFLICT (tenant_id, module_id)
              DO UPDATE SET
                is_active = true,
                assigned_at = NOW(),
                assigned_by = $3,
                quantities = $4,
                updated_at = NOW()`,
              [tenantId, moduleId, assignedBy, JSON.stringify(quantities)],
            );
            assignedModules.push(moduleId);
            this.logger.log(`Assigned module ${moduleId} to tenant ${tenantId}`);
          }

          // Add to pricing calculation
          moduleSelections.push({
            moduleId,
            moduleCode: moduleInfo.code,
            moduleName: moduleInfo.name,
            quantities: {
              users: quantities.users ?? 5,
              farms: quantities.farms ?? 1,
              ponds: quantities.ponds ?? 10,
              sensors: quantities.sensors ?? 5,
              ...quantities,
            },
          });
        } catch (error) {
          const errorMessage = (error as Error).message;
          this.logger.error(
            `Failed to assign module ${moduleId} to tenant ${tenantId}: ${errorMessage}`,
          );
          failedModules.push({ moduleId, error: errorMessage });
        }
      }
    });

    // Calculate pricing for assigned modules
    let pricing: PricingCalculation | undefined;
    let totalMonthlyPrice = 0;

    if (moduleSelections.length > 0) {
      try {
        pricing = await this.pricingCalculator.calculatePricing({
          modules: moduleSelections,
          tier,
          billingCycle,
        });
        totalMonthlyPrice = pricing.monthlyTotal;

        // Update pricing on tenant_modules
        await this.updateTenantModulesPricing(tenantId, pricing);
      } catch (error) {
        this.logger.warn(
          `Could not calculate pricing: ${(error as Error).message}`,
        );
      }
    }

    // Publish event for billing service
    if (assignedModules.length > 0) {
      this.publishModulesAssignedEvent(tenantId, assignedModules, pricing, assignedBy);
    }

    // Create audit log
    await this.createAuditLog(
      tenantId,
      'MODULES_ASSIGNED',
      {
        assignedModules,
        failedModules,
        pricing: pricing
          ? { monthlyTotal: pricing.monthlyTotal, tier, billingCycle }
          : undefined,
      },
      assignedBy,
    );

    return {
      success: failedModules.length === 0,
      tenantId,
      assignedModules,
      failedModules,
      pricing,
      totalMonthlyPrice,
    };
  }

  /**
   * Remove a module from a tenant
   */
  async removeModuleFromTenant(
    tenantId: string,
    moduleId: string,
    removedBy: string,
  ): Promise<void> {
    this.logger.log(`Removing module ${moduleId} from tenant ${tenantId}`);

    const isAssigned = await this.isModuleAssigned(tenantId, moduleId);
    if (!isAssigned) {
      throw new NotFoundException(
        `Module ${moduleId} is not assigned to tenant ${tenantId}`,
      );
    }

    await this.dataSource.query(
      `
      UPDATE tenant_modules
      SET is_active = false,
          deactivated_at = NOW(),
          deactivated_by = $3,
          updated_at = NOW()
      WHERE tenant_id = $1 AND module_id = $2
      `,
      [tenantId, moduleId, removedBy],
    );

    // Publish event
    this.eventBus.publish({
      eventType: 'ModuleRemovedFromTenant',
      tenantId,
      moduleId,
      removedBy,
      timestamp: new Date(),
    });

    // Create audit log
    await this.createAuditLog(
      tenantId,
      'MODULE_REMOVED',
      { moduleId },
      removedBy,
    );

    this.logger.log(`Module ${moduleId} removed from tenant ${tenantId}`);
  }

  /**
   * Get all modules assigned to a tenant with pricing
   */
  async getTenantModulesWithPricing(
    tenantId: string,
  ): Promise<TenantModuleWithPricing[]> {
    const results = await this.dataSource.query(
      `
      SELECT
        tm.id,
        tm.tenant_id as "tenantId",
        tm.module_id as "moduleId",
        m.code as "moduleCode",
        m.name as "moduleName",
        m.description as "moduleDescription",
        m.icon as "moduleIcon",
        tm.is_active as "isActive",
        tm.assigned_at as "assignedAt",
        tm.expires_at as "expiresAt",
        COALESCE(tm.quantities, '{}')::jsonb as quantities,
        COALESCE(tm.monthly_price, 0) as "monthlyPrice",
        COALESCE(tm.configuration, '{}')::jsonb as configuration
      FROM tenant_modules tm
      JOIN modules m ON m.id = tm.module_id
      WHERE tm.tenant_id = $1 AND tm.is_active = true
      ORDER BY m.name ASC
      `,
      [tenantId],
    );

    return results.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      tenantId: row.tenantId as string,
      moduleId: row.moduleId as string,
      moduleCode: row.moduleCode as string,
      moduleName: row.moduleName as string,
      moduleDescription: row.moduleDescription as string | undefined,
      moduleIcon: row.moduleIcon as string | undefined,
      isActive: row.isActive as boolean,
      assignedAt: row.assignedAt as Date,
      expiresAt: row.expiresAt as Date | undefined,
      quantities: row.quantities as ModuleQuantities,
      monthlyPrice: parseFloat(row.monthlyPrice as string) || 0,
      configuration: row.configuration as Record<string, unknown>,
    }));
  }

  /**
   * Check if a module is assigned to a tenant
   */
  async isModuleAssigned(tenantId: string, moduleId: string): Promise<boolean> {
    const result = await this.dataSource.query(
      `
      SELECT EXISTS(
        SELECT 1 FROM tenant_modules
        WHERE tenant_id = $1 AND module_id = $2 AND is_active = true
      ) as exists
      `,
      [tenantId, moduleId],
    );
    // PostgreSQL returns boolean as true/false or 't'/'f' depending on driver
    const exists = result[0]?.exists;
    return exists === true || exists === 't' || exists === 'true';
  }

  /**
   * Get tenant's total monthly price for all modules
   */
  async getTenantTotalMonthlyPrice(tenantId: string): Promise<number> {
    const result = await this.dataSource.query(
      `
      SELECT COALESCE(SUM(monthly_price), 0) as total
      FROM tenant_modules
      WHERE tenant_id = $1 AND is_active = true
      `,
      [tenantId],
    );
    return parseFloat(result[0]?.total) || 0;
  }

  /**
   * Recalculate pricing for a tenant's modules
   */
  async recalculateTenantPricing(
    tenantId: string,
    tier: PlanTier = PlanTier.STARTER,
    billingCycle: BillingCycle = BillingCycle.MONTHLY,
  ): Promise<PricingCalculation> {
    const modules = await this.getTenantModulesWithPricing(tenantId);

    const moduleSelections: ModuleSelection[] = modules.map((m) => ({
      moduleId: m.moduleId,
      moduleCode: m.moduleCode,
      moduleName: m.moduleName,
      quantities: m.quantities,
    }));

    const pricing = await this.pricingCalculator.calculatePricing({
      modules: moduleSelections,
      tier,
      billingCycle,
    });

    // Update pricing in database
    await this.updateTenantModulesPricing(tenantId, pricing);

    return pricing;
  }

  // ============== Private Helper Methods ==============

  private async getTenant(
    tenantId: string,
  ): Promise<{ id: string; name: string; tier?: string } | null> {
    const result = await this.dataSource.query(
      `SELECT id, name, tier FROM tenants WHERE id = $1`,
      [tenantId],
    );
    return result[0] || null;
  }

  private async getModuleInfoMap(
    moduleIds: string[],
  ): Promise<Map<string, ModuleInfo>> {
    if (moduleIds.length === 0) {
      return new Map();
    }

    const placeholders = moduleIds.map((_, i) => `$${i + 1}`).join(', ');
    const results = await this.dataSource.query(
      `
      SELECT id, code, name, description, icon
      FROM modules
      WHERE id IN (${placeholders})
      `,
      moduleIds,
    );

    const map = new Map<string, ModuleInfo>();
    for (const row of results) {
      map.set(row.id, {
        id: row.id,
        code: row.code,
        name: row.name,
        description: row.description,
        icon: row.icon,
      });
    }
    return map;
  }

  private async insertModuleAssignment(
    tenantId: string,
    moduleId: string,
    quantities: ModuleQuantities,
    assignedBy: string,
  ): Promise<void> {
    await this.dataSource.query(
      `
      INSERT INTO tenant_modules (
        id, tenant_id, module_id, is_active, assigned_at,
        assigned_by, quantities, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1, $2, true, NOW(), $3, $4, NOW(), NOW()
      )
      ON CONFLICT (tenant_id, module_id)
      DO UPDATE SET
        is_active = true,
        assigned_at = NOW(),
        assigned_by = $3,
        quantities = $4,
        updated_at = NOW()
      `,
      [tenantId, moduleId, assignedBy, JSON.stringify(quantities)],
    );
  }

  private async updateModuleQuantities(
    tenantId: string,
    moduleId: string,
    quantities: ModuleQuantities,
    updatedBy: string,
  ): Promise<void> {
    await this.dataSource.query(
      `
      UPDATE tenant_modules
      SET quantities = $3,
          updated_at = NOW(),
          assigned_by = $4
      WHERE tenant_id = $1 AND module_id = $2
      `,
      [tenantId, moduleId, JSON.stringify(quantities), updatedBy],
    );
  }

  private async updateTenantModulesPricing(
    tenantId: string,
    pricing: PricingCalculation,
  ): Promise<void> {
    for (const moduleBreakdown of pricing.modules) {
      await this.dataSource.query(
        `
        UPDATE tenant_modules
        SET monthly_price = $3, updated_at = NOW()
        WHERE tenant_id = $1 AND module_id = $2
        `,
        [tenantId, moduleBreakdown.moduleId, moduleBreakdown.total],
      );
    }
  }

  private publishModulesAssignedEvent(
    tenantId: string,
    moduleIds: string[],
    pricing: PricingCalculation | undefined,
    assignedBy: string,
  ): void {
    this.eventBus.publish({
      eventType: 'TenantModulesAssigned',
      tenantId,
      moduleIds,
      pricing: pricing
        ? {
            monthlyTotal: pricing.monthlyTotal,
            annualTotal: pricing.annualTotal,
            tier: pricing.tier,
            currency: pricing.currency,
          }
        : undefined,
      assignedBy,
      timestamp: new Date(),
    });
  }

  private async createAuditLog(
    tenantId: string,
    action: string,
    details: Record<string, unknown>,
    performedBy: string,
  ): Promise<void> {
    try {
      await this.dataSource.query(
        `
        INSERT INTO audit_logs (
          id, tenant_id, action, entity_type, entity_id,
          details, performed_by, performed_at, created_at
        ) VALUES (
          gen_random_uuid(), $1, $2, 'tenant_modules', $1,
          $3, $4, NOW(), NOW()
        )
        `,
        [tenantId, action, JSON.stringify(details), performedBy],
      );
    } catch (error) {
      // Don't fail the main operation if audit logging fails
      this.logger.warn(
        `Failed to create audit log: ${(error as Error).message}`,
      );
    }
  }
}
