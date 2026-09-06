/**
 * The module price sheet, from the platform-admin side (ADR-0013,
 * BILLING-CRITICAL-002).
 *
 * admin-api owns the ModulePricing page and the quote UI; billing owns the
 * rows AND the arithmetic. This service reads the read-only mapping of
 * `billing.module_prices` and forwards every write and every quote as a
 * `request.billing.admin.*` command.
 *
 * The calculation moved with the prices. `PricingCalculatorService` used to
 * fetch the sheet and multiply it out here — in floats, then send the result
 * back to billing as the priced module items of a provisioning command, so
 * the service that owns the prices trusted someone else's total. There is now
 * one multiplication, in `Decimal`, where the sheet is.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type {
  BillingModulePriceInput,
  BillingModuleQuote,
  BillingModuleQuoteSelection,
  BillingPlanTier,
  BillingPricingMetricType,
} from '@platform/event-contracts';
import { DataSource, Repository } from 'typeorm';

import {
  ModulePriceMetricDto,
  ModulePricePageDto,
  ModulePriceResponseDto,
  ModulePriceTierMultiplierDto,
} from '../dto/module-price-response.dto';
import { ModulePriceReadOnly } from '../entities/external/module-price.entity';

import { BillingAdminCommandClientService } from './billing-admin-command-client.service';

interface ModuleInfoRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  icon: string | null;
  isActive: boolean;
}

@Injectable()
export class ModulePricingService {
  private readonly logger = new Logger(ModulePricingService.name);

  constructor(
    @InjectRepository(ModulePriceReadOnly)
    private readonly sheets: Repository<ModulePriceReadOnly>,
    private readonly billingCommands: BillingAdminCommandClientService,
    private readonly dataSource: DataSource,
  ) {}

  // ── Reads (billing's rows, read-only) ──────────────────────────────────

  /** The sheet in force for a module id, now. */
  async getModulePricing(moduleId: string): Promise<ModulePriceResponseDto | null> {
    const candidates = await this.sheets.find({
      where: { moduleId, isActive: true },
      order: { effectiveFrom: 'DESC' },
    });
    const sheet = candidates.find(isInForce);
    return sheet ? toModulePriceResponse(sheet) : null;
  }

  async getModulePricingByCode(moduleCode: string): Promise<ModulePriceResponseDto | null> {
    const candidates = await this.sheets.find({
      where: { moduleCode, isActive: true },
      order: { effectiveFrom: 'DESC' },
    });
    const sheet = candidates.find(isInForce);
    return sheet ? toModulePriceResponse(sheet) : null;
  }

  async getAllModulePricings(): Promise<ModulePriceResponseDto[]> {
    const candidates = await this.sheets.find({
      where: { isActive: true },
      order: { moduleCode: 'ASC', effectiveFrom: 'DESC' },
    });
    const byCode = new Map<string, ModulePriceReadOnly>();
    for (const sheet of candidates) {
      if (isInForce(sheet) && !byCode.has(sheet.moduleCode)) byCode.set(sheet.moduleCode, sheet);
    }
    return [...byCode.values()].map(toModulePriceResponse);
  }

  /**
   * The sheets in force, joined to the module each prices.
   *
   * The module's name, description and icon live in `auth.modules`, which
   * billing holds no grant on — admin does, which is why this join happens
   * here rather than in the price sheet.
   */
  async getAllModulePricingsWithModuleInfo(): Promise<ModulePriceResponseDto[]> {
    const sheets = await this.getAllModulePricings();
    if (sheets.length === 0) return [];

    const modules = await this.dataSource.query<ModuleInfoRow[]>(
      `SELECT id, code, name, description, icon, "isActive"
         FROM auth.modules
        WHERE id = ANY($1::uuid[])`,
      [sheets.map((sheet) => sheet.moduleId)],
    );
    const byId = new Map(modules.map((module) => [module.id, module]));

    return sheets.map((sheet) => {
      const module = byId.get(sheet.moduleId);
      return {
        ...sheet,
        moduleName: module?.name ?? sheet.moduleCode,
        moduleDescription: module?.description ?? undefined,
        moduleIcon: module?.icon ?? undefined,
        isModuleActive: module?.isActive ?? true,
      };
    });
  }

  async getPricingHistory(
    moduleId: string,
    options: { page?: number; limit?: number } = {},
  ): Promise<ModulePricePageDto> {
    const page = options.page ?? 1;
    const limit = options.limit ?? 50;
    const [data, total] = await this.sheets.findAndCount({
      where: { moduleId },
      order: { effectiveFrom: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data: data.map(toModulePriceResponse), total, page, limit };
  }

  async findById(modulePriceId: string): Promise<ModulePriceResponseDto> {
    const found = await this.sheets.findOne({ where: { id: modulePriceId } });
    if (!found) throw new NotFoundException(`Module price ${modulePriceId} not found`);
    return toModulePriceResponse(found);
  }

  // ── Writes (forwarded to billing) ──────────────────────────────────────

  async setModulePricing(
    input: BillingModulePriceInput,
    actorId: string,
  ): Promise<ModulePriceResponseDto> {
    const snapshot = await this.billingCommands.setModulePrice(input, actorId);
    return fromModulePriceSnapshot(snapshot);
  }

  /**
   * Republish a sheet with changes. Anything omitted keeps what the current
   * sheet carries; the result is a NEW effective window, never an edit, so an
   * invoice can be read back against the prices that produced it.
   */
  async updateModulePricing(
    modulePriceId: string,
    changes: {
      pricingMetrics?: Array<{
        metricType: BillingPricingMetricType;
        price: string;
        description?: string;
        minQuantity?: number;
        maxQuantity?: number;
        includedQuantity?: number;
      }>;
      tierMultipliers?: Partial<Record<BillingPlanTier, string>>;
      currency?: string;
      effectiveFrom?: string;
      effectiveTo?: string;
      notes?: string;
    },
    actorId: string,
  ): Promise<ModulePriceResponseDto> {
    const current = await this.findById(modulePriceId);
    const metrics = changes.pricingMetrics
      ? changes.pricingMetrics.map((metric) => ({
          metricType: metric.metricType,
          price: metric.price,
          description: metric.description,
          minQuantity: metric.minQuantity,
          maxQuantity: metric.maxQuantity,
          includedQuantity: metric.includedQuantity,
        }))
      : current.metrics.map((metric) => ({ ...metric }));

    const tierMultipliers = changes.tierMultipliers
      ? Object.entries(changes.tierMultipliers)
          .filter(([, multiplier]) => multiplier !== undefined)
          .map(([tier, multiplier]) => ({
            tier: tier as BillingPlanTier,
            multiplier: multiplier as string,
          }))
      : current.tierMultipliers.map((entry) => ({ ...entry }));

    return this.setModulePricing(
      {
        moduleId: current.moduleId,
        moduleCode: current.moduleCode,
        currency: changes.currency ?? current.currency,
        effectiveFrom: changes.effectiveFrom,
        effectiveTo: changes.effectiveTo ?? null,
        notes: changes.notes ?? current.notes,
        metrics,
        tierMultipliers,
      },
      actorId,
    );
  }

  async deactivatePricing(
    modulePriceId: string,
    actorId: string,
  ): Promise<ModulePriceResponseDto> {
    const snapshot = await this.billingCommands.deactivateModulePrice(modulePriceId, actorId);
    return fromModulePriceSnapshot(snapshot);
  }

  /**
   * Seed the default sheet for every module that has none.
   *
   * The code→id mapping is resolved here because `auth.modules` is admin's
   * grant, not billing's — billing would otherwise have to guess an id or
   * carry a grant it should not have.
   */
  async seedDefaultPricing(moduleCodes: string[], actorId: string): Promise<number> {
    const rows = await this.dataSource.query<Array<{ id: string; code: string }>>(
      `SELECT id, code FROM auth.modules WHERE code = ANY($1::text[])`,
      [moduleCodes],
    );
    if (rows.length === 0) {
      this.logger.warn(
        JSON.stringify({ event: 'module-price.seed.no-modules', requested: moduleCodes.length }),
      );
      return 0;
    }
    return this.billingCommands.seedModulePrices(
      rows.map((row) => ({ moduleCode: row.code, moduleId: row.id })),
      actorId,
    );
  }

  // ── Quoting (forwarded to billing) ─────────────────────────────────────

  async quote(
    request: {
      modules: BillingModuleQuoteSelection[];
      tier: BillingPlanTier;
      billingCycle: BillingModuleQuote['billingCycle'];
      tenantId?: string;
      discountCode?: string;
      subscriptionChange?: 'new' | 'upgrade' | 'other';
      taxRate?: string;
      /** A hand-entered negotiated discount; billing applies it (ADR-0013). */
      negotiatedDiscountPercent?: string;
      negotiatedDiscountAmount?: string;
    },
    actorId: string,
  ): Promise<BillingModuleQuote> {
    return this.billingCommands.quoteModuleSelection(request, actorId);
  }
}

/** Is this sheet the one in force right now? Used as an array predicate. */
function isInForce(sheet: ModulePriceReadOnly): boolean {
  const now = new Date();
  const from = new Date(sheet.effectiveFrom);
  const to = sheet.effectiveTo ? new Date(sheet.effectiveTo) : null;
  return sheet.isActive && now >= from && (to === null || now <= to);
}

/**
 * A read of billing's sheet becomes the same wire shape a write returns.
 * `Decimal` fields become their exact decimal string — the value the client
 * would have received anyway through `toJSON`, now stated in the type.
 */
function toModulePriceResponse(sheet: ModulePriceReadOnly): ModulePriceResponseDto {
  const metrics: ModulePriceMetricDto[] = (sheet.metrics ?? []).map((metric) => ({
    metricType: metric.metricType,
    price: metric.price.toString(),
    description: metric.description ?? undefined,
    minQuantity: metric.minQuantity ?? undefined,
    maxQuantity: metric.maxQuantity ?? undefined,
    includedQuantity: metric.includedQuantity ?? undefined,
  }));
  const tierMultipliers: ModulePriceTierMultiplierDto[] = (sheet.tierMultipliers ?? []).map(
    (entry) => ({ tier: entry.tier, multiplier: entry.multiplier.toString() }),
  );

  return {
    id: sheet.id,
    moduleId: sheet.moduleId,
    moduleCode: sheet.moduleCode,
    currency: sheet.currency,
    effectiveFrom: new Date(sheet.effectiveFrom).toISOString(),
    effectiveTo: sheet.effectiveTo ? new Date(sheet.effectiveTo).toISOString() : undefined,
    isActive: sheet.isActive,
    version: sheet.version,
    notes: sheet.notes ?? undefined,
    metrics,
    tierMultipliers,
    createdAt: new Date(sheet.createdAt).toISOString(),
    updatedAt: new Date(sheet.updatedAt).toISOString(),
    createdBy: sheet.createdBy ?? undefined,
    updatedBy: sheet.updatedBy ?? undefined,
  };
}

/** billing's command reply, in the same wire shape as a read. */
function fromModulePriceSnapshot(
  snapshot: Awaited<ReturnType<BillingAdminCommandClientService['setModulePrice']>>,
): ModulePriceResponseDto {
  return {
    id: snapshot.id,
    moduleId: snapshot.moduleId,
    moduleCode: snapshot.moduleCode,
    currency: snapshot.currency,
    effectiveFrom: snapshot.effectiveFrom,
    effectiveTo: snapshot.effectiveTo ?? undefined,
    isActive: snapshot.isActive,
    version: snapshot.version,
    notes: snapshot.notes ?? undefined,
    metrics: snapshot.metrics.map((metric) => ({
      metricType: metric.metricType,
      price: metric.price,
      description: metric.description,
      minQuantity: metric.minQuantity,
      maxQuantity: metric.maxQuantity,
      includedQuantity: metric.includedQuantity,
    })),
    tierMultipliers: snapshot.tierMultipliers.map((entry) => ({
      tier: entry.tier,
      multiplier: entry.multiplier,
    })),
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    createdBy: snapshot.createdBy ?? undefined,
    updatedBy: snapshot.updatedBy ?? undefined,
  };
}
