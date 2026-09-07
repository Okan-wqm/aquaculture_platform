import * as crypto from 'crypto';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  createBaseEvent,
  type BillingModuleQuote,
  type BillingModuleQuoteSelection,
  type BillingProvisioningModuleItem,
} from '@platform/event-contracts';
import { DataSource } from 'typeorm';

import { PlanTier, BillingCycle } from '../../../billing/entities/plan-definition.entity';
import { ModulePricingService } from '../../../billing/services/module-pricing.service';
import { AuthTenantProvisioningClientService } from '../../../tenant/services/auth-tenant-provisioning-client.service';

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
  pricing?: BillingModuleQuote;
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
    private readonly modulePricing: ModulePricingService,
    private readonly authProvisioningClient: AuthTenantProvisioningClientService,
  ) {}

  /**
   * Assign multiple modules to a tenant
   */
  async assignModulesToTenant(dto: BulkModuleAssignmentDto): Promise<ModuleAssignmentResult> {
    const {
      tenantId,
      modules,
      assignedBy,
      tier = PlanTier.STARTER,
      billingCycle = BillingCycle.MONTHLY,
    } = dto;

    this.logger.log(`Assigning ${modules.length} modules to tenant ${tenantId}`);

    // Validate tenant exists
    const tenant = await this.getTenant(tenantId);
    if (!tenant) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }

    const assignedModules: string[] = [];
    const failedModules: Array<{ moduleId: string; error: string }> = [];

    // Get module information for all requested modules
    const moduleInfoMap = await this.getModuleInfoMap(modules.map((m) => m.moduleId));

    // Prepare modules for pricing calculation
    const moduleSelections: BillingModuleQuoteSelection[] = [];

    for (const moduleRequest of modules) {
      const { moduleId, quantities = {} } = moduleRequest;
      const moduleInfo = moduleInfoMap.get(moduleId);
      if (!moduleInfo) {
        failedModules.push({
          moduleId,
          error: `Module ${moduleId} not found`,
        });
        continue;
      }

      assignedModules.push(moduleId);
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
    }

    if (assignedModules.length > 0) {
      await this.authProvisioningClient.assignTenantModules({
        operationId: crypto.randomUUID(),
        tenantId,
        requestReference: this.commandRequestReference('AssignModules', tenantId, {
          moduleIds: assignedModules,
          modules,
          assignedBy,
        }),
        actor: { id: assignedBy, type: 'user' },
        moduleIds: assignedModules,
        modules: modules
          .filter((module) => assignedModules.includes(module.moduleId))
          .map((module) => ({
            moduleId: module.moduleId,
            ...(module.quantities ? { quantities: { ...module.quantities } } : {}),
          })),
        assignedBy,
      });
      this.logger.log(
        `Delegated ${assignedModules.length} module assignments to auth-service for tenant ${tenantId}`,
      );
    }

    // Calculate pricing for assigned modules
    let pricing: BillingModuleQuote | undefined;
    let totalMonthlyPrice = 0;

    if (moduleSelections.length > 0) {
      try {
        pricing = await this.modulePricing.quote(
          { modules: moduleSelections, tier, billingCycle },
          assignedBy,
        );
        totalMonthlyPrice = Number(pricing.monthlyTotal);

        // Update pricing on tenant_modules
        await this.updateTenantModulesPricing(tenantId, pricing);
      } catch (error) {
        this.logger.warn(`Could not calculate pricing: ${(error as Error).message}`);
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
        pricing: pricing ? { monthlyTotal: pricing.monthlyTotal, tier, billingCycle } : undefined,
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
      throw new NotFoundException(`Module ${moduleId} is not assigned to tenant ${tenantId}`);
    }

    const result = await this.authProvisioningClient.removeTenantModule({
      operationId: crypto.randomUUID(),
      tenantId,
      requestReference: this.commandRequestReference('RemoveModule', tenantId, {
        moduleId,
        removedBy,
      }),
      actor: { id: removedBy, type: 'user' },
      moduleId,
      removedBy,
    });
    if ((result.modulesRemoved ?? 0) === 0) {
      throw new NotFoundException(`Module ${moduleId} is not assigned to tenant ${tenantId}`);
    }

    // Publish event
    this.eventBus.publish({
      ...createBaseEvent('ModuleRemovedFromTenant', tenantId, {
        aggregateId: moduleId,
        aggregateType: 'TenantModule',
      }),
      moduleId,
      removedBy,
    });

    // Create audit log
    await this.createAuditLog(tenantId, 'MODULE_REMOVED', { moduleId }, removedBy);

    this.logger.log(`Module ${moduleId} removed from tenant ${tenantId}`);
  }

  /**
   * Get all modules assigned to a tenant with pricing
   */
  async getTenantModulesWithPricing(tenantId: string): Promise<TenantModuleWithPricing[]> {
    const results = await this.dataSource.query(
      `
      SELECT
        tm.id,
        tm."tenantId",
        tm."moduleId",
        m.code as "moduleCode",
        m.name as "moduleName",
        m.description as "moduleDescription",
        m.icon as "moduleIcon",
        tm."isEnabled" as "isActive",
        tm."activatedAt" as "assignedAt",
        tm."expiresAt",
        COALESCE((tm.configuration->>'quantities')::jsonb, '{}')::jsonb as quantities,
        0 as "monthlyPrice",
        COALESCE(tm.configuration, '{}')::jsonb as configuration
      FROM auth.tenant_modules tm
      JOIN auth.modules m ON m.id = tm."moduleId"
      WHERE tm."tenantId" = $1 AND tm."isEnabled" = true
      ORDER BY m.name ASC
      `,
      [tenantId],
    );

    return results.map((row: Record<string, unknown>) => ({
      id: row['id'] as string,
      tenantId: row['tenantId'] as string,
      moduleId: row['moduleId'] as string,
      moduleCode: row['moduleCode'] as string,
      moduleName: row['moduleName'] as string,
      moduleDescription: row['moduleDescription'] as string | undefined,
      moduleIcon: row['moduleIcon'] as string | undefined,
      isActive: row['isActive'] as boolean,
      assignedAt: row['assignedAt'] as Date,
      expiresAt: row['expiresAt'] as Date | undefined,
      quantities: row['quantities'] as ModuleQuantities,
      monthlyPrice: parseFloat(row['monthlyPrice'] as string) || 0,
      configuration: row['configuration'] as Record<string, unknown>,
    }));
  }

  /**
   * Resolve fully-priced module line items for a tenant-provisioning command.
   *
   * This is the single writer boundary's answer to the billing-subscription
   * break (ORPHAN-CRITICAL-393 / ORPHAN-HIGH-394): admin-api OWNS module
   * code/name resolution (`auth.modules`, via its own grant), so it resolves
   * every selected module into `{moduleId, code, name, quantities, lineItems,
   * subtotal, discountAmount, total}` HERE and passes it in the command.
   * billing then writes `billing.subscription_module_items` directly with no
   * schema-unqualified `modules` query (which failed → tx rollback → lost
   * subscription) and no invented $0 prices.
   *
   * ADR-0013 changed WHO prices it: the sheet is `billing.module_prices` and
   * the multiplication happens in billing, asked for over
   * `request.billing.admin.quoteModuleSelection`. admin still resolves the
   * identity of each module, because `auth.modules` is admin's grant.
   *
   * Side-effect-free by design: unlike assignModulesToTenant it does NOT call
   * auth-service, publish events, or write audit rows — it is a pure pricing
   * resolution safe to run inside the idempotent `create_subscription` saga step.
   *
   * A module with no active price sheet is legitimately free; it yields a $0
   * module row rather than throwing — provisioning must not fail on absent
   * catalog pricing (that is the very rollback this fix removes) — and the
   * quote names it in `unpricedModuleCodes`.
   */
  async resolveProvisioningModuleItems(params: {
    modules: Array<{ moduleId: string; quantities?: ModuleQuantities }>;
    tier: PlanTier;
    billingCycle: BillingCycle;
    /** Recorded by billing against the quote; never a client-supplied string. */
    actorId: string;
  }): Promise<BillingProvisioningModuleItem[]> {
    const moduleIds = params.modules.map((m) => m.moduleId);
    if (moduleIds.length === 0) {
      return [];
    }

    const moduleInfoMap = await this.getModuleInfoMap(moduleIds);

    const moduleSelections: BillingModuleQuoteSelection[] = params.modules.map((m) => {
      const info = moduleInfoMap.get(m.moduleId);
      if (!info) {
        // Modules are validated + assigned at the assign_modules step BEFORE
        // provisioning reaches create_subscription; a missing auth.modules row
        // here is a genuine data-integrity fault (not the free-tier case), so
        // fail loud. No subscription has been created yet — the saga step fails
        // cleanly with nothing to roll back.
        throw new NotFoundException(
          `Module ${m.moduleId} not found in auth.modules during subscription pricing resolution`,
        );
      }
      return {
        moduleId: m.moduleId,
        moduleCode: info.code,
        moduleName: info.name,
        quantities: m.quantities ?? {},
      };
    });

    // ADR-0013: billing owns the price sheet, so billing does the
    // multiplication. admin used to compute these totals itself and send them
    // back to billing in the provisioning command — the service that owns the
    // prices trusting someone else's arithmetic.
    const quote = await this.modulePricing.quote(
      {
        modules: moduleSelections,
        tier: params.tier,
        billingCycle: params.billingCycle,
      },
      params.actorId,
    );
    const breakdownByModuleId = new Map(
      quote.modules.map((breakdown) => [breakdown.moduleId, breakdown]),
    );

    return moduleSelections.map((selection) => {
      const breakdown = breakdownByModuleId.get(selection.moduleId);
      return {
        moduleId: selection.moduleId,
        code: selection.moduleCode,
        name: selection.moduleName ?? selection.moduleCode,
        quantities: { moduleId: selection.moduleId, ...selection.quantities },
        lineItems: breakdown?.lineItems ?? [],
        // A module with no active price sheet resolves to 0 — free/core tier
        // is a legitimate answer, and `quote.unpricedModuleCodes` names them.
        subtotal: breakdown?.subtotal ?? '0',
        discountAmount: breakdown?.tierDiscount ?? '0',
        total: breakdown?.total ?? '0',
      };
    });
  }

  /**
   * Check if a module is assigned to a tenant
   */
  async isModuleAssigned(tenantId: string, moduleId: string): Promise<boolean> {
    const result = await this.dataSource.query(
      `
      SELECT EXISTS(
        SELECT 1 FROM auth.tenant_modules
        WHERE "tenantId" = $1 AND "moduleId" = $2 AND "isEnabled" = true
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
    // monthly_price column does not exist; pricing is handled by the pricing service
    this.logger.log(
      `getTenantTotalMonthlyPrice called for tenant ${tenantId} - returning 0 (use pricing service for actual price)`,
    );
    return 0;
  }

  /**
   * Recalculate pricing for a tenant's modules
   */
  async recalculateTenantPricing(
    tenantId: string,
    actorId: string,
    tier: PlanTier = PlanTier.STARTER,
    billingCycle: BillingCycle = BillingCycle.MONTHLY,
  ): Promise<BillingModuleQuote> {
    const modules = await this.getTenantModulesWithPricing(tenantId);

    const moduleSelections: BillingModuleQuoteSelection[] = modules.map((m) => ({
      moduleId: m.moduleId,
      moduleCode: m.moduleCode,
      moduleName: m.moduleName,
      quantities: m.quantities,
    }));

    const quote = await this.modulePricing.quote(
      { modules: moduleSelections, tier, billingCycle },
      actorId,
    );

    await this.updateTenantModulesPricing(tenantId, quote);

    return quote;
  }

  // ============== Private Helper Methods ==============

  private async getTenant(
    tenantId: string,
  ): Promise<{ id: string; name: string; plan?: string } | null> {
    const result = await this.dataSource.query(
      `SELECT id, name, plan FROM auth.tenants WHERE id = $1`,
      [tenantId],
    );
    return result[0] || null;
  }

  private async getModuleInfoMap(moduleIds: string[]): Promise<Map<string, ModuleInfo>> {
    if (moduleIds.length === 0) {
      return new Map();
    }

    const placeholders = moduleIds.map((_, i) => `$${i + 1}`).join(', ');
    const results = await this.dataSource.query(
      `
      SELECT id, code, name, description, icon
      FROM auth.modules
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

  private async updateTenantModulesPricing(
    tenantId: string,
    pricing: BillingModuleQuote,
  ): Promise<void> {
    // monthly_price column does not exist in tenant_modules; pricing is tracked by the pricing service.
    // Just log the calculated pricing for observability.
    for (const moduleBreakdown of pricing.modules) {
      this.logger.log(
        `Pricing calculated for tenant ${tenantId}, module ${moduleBreakdown.moduleId}: ${moduleBreakdown.total}`,
      );
    }
  }

  private publishModulesAssignedEvent(
    tenantId: string,
    moduleIds: string[],
    pricing: BillingModuleQuote | undefined,
    assignedBy: string,
  ): void {
    this.eventBus.publish({
      ...createBaseEvent('TenantModulesAssigned', tenantId, {
        aggregateId: tenantId,
        aggregateType: 'Tenant',
      }),
      moduleIds,
      pricingMonthlyTotal: pricing ? Number(pricing.monthlyTotal) : undefined,
      pricingAnnualTotal: pricing ? Number(pricing.annualTotal) : undefined,
      pricingTier: pricing?.tier,
      pricingCurrency: pricing?.currency,
      assignedBy,
      version: 2,
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
        INSERT INTO admin.audit_logs (
          id, "tenantId", action, "entityType", "entityId",
          details, "performedBy", "createdAt"
        ) VALUES (
          gen_random_uuid(), $1, $2, 'tenant_modules', $1,
          $3, $4, NOW()
        )
        `,
        [tenantId, action, JSON.stringify(details), performedBy],
      );
    } catch (error) {
      // Don't fail the main operation if audit logging fails
      this.logger.warn(`Failed to create audit log: ${(error as Error).message}`);
    }
  }

  private commandRequestReference(commandType: string, tenantId: string, payload: unknown): string {
    return `${commandType}:${tenantId}:${this.hashPayload(payload)}`;
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
}
