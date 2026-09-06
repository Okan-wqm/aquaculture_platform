/**
 * The module price sheet writer and the quote engine — billing owns both
 * (ADR-0013, BILLING-CRITICAL-002).
 *
 * admin-api used to hold the sheet, do the arithmetic, and then send the
 * result back to billing as the priced module items of a provisioning
 * command. Whoever owns the prices owns the multiplication, so both live here
 * and admin asks for the quote.
 */
import { roundToCurrency } from '@aquaculture/backend-common/monetary';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import type {
  BillingModuleQuoteRequest,
  BillingModulePriceInput,
  BillingModulePriceSnapshot,
  BillingModuleQuote,
  BillingModuleQuoteBreakdown,
} from '@platform/event-contracts';
import { BILLING_PRICING_METRIC_TYPES, BillingPlanTier } from '@platform/event-contracts';
import Decimal from 'decimal.js';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';

import {
  ModulePrice,
  ModulePriceMetric,
  ModulePriceTierMultiplier,
} from '../entities/module-price.entity';

import { DEFAULT_MODULE_PRICES } from './default-module-prices';
import { BILLING_CYCLE_DISCOUNT_RATE, BILLING_CYCLE_MONTHS, priceModule } from './module-quote';

import type { DiscountCodeService } from './discount-code.service';

const VALID_TIERS: readonly BillingPlanTier[] = Object.values(BillingPlanTier);

@Injectable()
export class ModulePricingService {
  private readonly logger = new Logger(ModulePricingService.name);

  constructor(
    @InjectRepository(ModulePrice)
    private readonly sheets: Repository<ModulePrice>,
    // Closing the previous window and opening the new one is one transaction:
    // a module must never be left with two active sheets or none.
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly discounts: DiscountCodeService,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────

  /** The sheet in force for one module code, at `at`. */
  async activeSheetFor(moduleCode: string, at: Date = new Date()): Promise<ModulePrice | null> {
    const candidates = await this.sheets.find({
      where: { moduleCode, isActive: true },
      order: { effectiveFrom: 'DESC' },
    });
    return candidates.find((sheet) => isInForce(sheet, at)) ?? null;
  }

  async activeSheetsFor(
    moduleCodes: string[],
    at: Date = new Date(),
  ): Promise<Map<string, ModulePrice>> {
    if (moduleCodes.length === 0) return new Map();
    const candidates = await this.sheets.find({
      where: { moduleCode: In(moduleCodes), isActive: true },
      order: { effectiveFrom: 'DESC' },
    });
    const byCode = new Map<string, ModulePrice>();
    for (const sheet of candidates) {
      if (!isInForce(sheet, at)) continue;
      if (!byCode.has(sheet.moduleCode)) byCode.set(sheet.moduleCode, sheet);
    }
    return byCode;
  }

  async findById(modulePriceId: string): Promise<ModulePrice> {
    const found = await this.sheets.findOne({ where: { id: modulePriceId } });
    if (!found) throw new NotFoundException(`Module price ${modulePriceId} not found`);
    return found;
  }

  // ── Writes ─────────────────────────────────────────────────────────────

  /**
   * Publish a new sheet for a module, closing whatever was in force.
   *
   * A price change is never an edit: the previous window is closed one second
   * before the new one opens, so an invoice can be read back against the
   * prices that produced it. The old service did the same thing in two
   * unrelated statements; here it is one transaction, so a module cannot end
   * up with two active sheets or none.
   */
  async setModulePrice(input: BillingModulePriceInput, actorId: string): Promise<ModulePrice> {
    const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date();
    const effectiveTo = input.effectiveTo ? new Date(input.effectiveTo) : null;
    if (effectiveTo && effectiveTo <= effectiveFrom) {
      throw new BadRequestException('effectiveTo must be after effectiveFrom');
    }
    const currency = (input.currency ?? 'USD').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new BadRequestException('currency must be an ISO-4217 code');
    }
    if (input.metrics.length === 0) {
      throw new BadRequestException('A module price sheet must declare at least one metric');
    }

    const seenMetrics = new Set<string>();
    for (const metric of input.metrics) {
      if (!BILLING_PRICING_METRIC_TYPES.includes(metric.metricType)) {
        throw new BadRequestException(`Unknown pricing metric ${String(metric.metricType)}`);
      }
      if (seenMetrics.has(metric.metricType)) {
        throw new BadRequestException(`Metric ${metric.metricType} is declared twice`);
      }
      seenMetrics.add(metric.metricType);
      if (new Decimal(metric.price).isNegative()) {
        throw new BadRequestException(`Metric ${metric.metricType} has a negative price`);
      }
    }

    const seenTiers = new Set<string>();
    for (const entry of input.tierMultipliers ?? []) {
      if (!VALID_TIERS.includes(entry.tier)) {
        throw new BadRequestException(`Unknown plan tier ${String(entry.tier)}`);
      }
      if (seenTiers.has(entry.tier)) {
        throw new BadRequestException(`Tier ${entry.tier} multiplier is declared twice`);
      }
      seenTiers.add(entry.tier);
      const multiplier = new Decimal(entry.multiplier);
      // The database enforces the same bound; this says why in words.
      if (multiplier.lessThanOrEqualTo(0) || multiplier.greaterThan(10)) {
        throw new BadRequestException(
          `Tier ${entry.tier} multiplier must be greater than 0 and at most 10`,
        );
      }
    }

    return this.dataSource.transaction(async (manager: EntityManager) => {
      const superseded = await manager.find(ModulePrice, {
        where: [
          { moduleId: input.moduleId, isActive: true, effectiveTo: IsNull() },
          { moduleId: input.moduleId, isActive: true },
        ],
      });
      const closesAt = new Date(effectiveFrom.getTime() - 1000);
      let previousVersion = 0;
      for (const sheet of superseded) {
        previousVersion = Math.max(previousVersion, sheet.version);
        if (sheet.effectiveTo !== null && sheet.effectiveTo < effectiveFrom) continue;
        sheet.isActive = false;
        sheet.effectiveTo = closesAt;
        sheet.updatedBy = actorId;
        await manager.save(sheet);
      }

      const sheet = manager.create(ModulePrice, {
        moduleId: input.moduleId,
        moduleCode: input.moduleCode,
        currency,
        effectiveFrom,
        effectiveTo,
        isActive: true,
        notes: input.notes ?? null,
        version: previousVersion + 1,
        createdBy: actorId,
        updatedBy: actorId,
      });
      const saved = await manager.save(sheet);

      await manager.save(
        input.metrics.map((metric) =>
          manager.create(ModulePriceMetric, {
            modulePriceId: saved.id,
            metricType: metric.metricType,
            price: new Decimal(metric.price),
            description: metric.description ?? null,
            minQuantity: metric.minQuantity ?? null,
            maxQuantity: metric.maxQuantity ?? null,
            includedQuantity: metric.includedQuantity ?? null,
          }),
        ),
      );

      const multipliers = input.tierMultipliers ?? [];
      if (multipliers.length > 0) {
        await manager.save(
          multipliers.map((entry) =>
            manager.create(ModulePriceTierMultiplier, {
              modulePriceId: saved.id,
              tier: entry.tier,
              multiplier: new Decimal(entry.multiplier),
            }),
          ),
        );
      }

      this.logger.log(
        JSON.stringify({
          event: 'module-price.published',
          moduleCode: input.moduleCode,
          version: saved.version,
          effectiveFrom: effectiveFrom.toISOString(),
          actorId,
        }),
      );

      const reloaded = await manager.findOne(ModulePrice, { where: { id: saved.id } });
      if (!reloaded) throw new Error('module price sheet vanished within its own transaction');
      return reloaded;
    });
  }

  async deactivate(modulePriceId: string, actorId: string): Promise<ModulePrice> {
    const sheet = await this.findById(modulePriceId);
    sheet.isActive = false;
    sheet.effectiveTo = new Date();
    sheet.updatedBy = actorId;
    const saved = await this.sheets.save(sheet);
    this.logger.log(
      JSON.stringify({
        event: 'module-price.deactivated',
        moduleCode: saved.moduleCode,
        actorId,
      }),
    );
    return saved;
  }

  /** Publish the default sheet for every named module that has none in force. */
  async seedDefaults(
    moduleIds: Array<{ moduleCode: string; moduleId: string }>,
    actorId: string,
  ): Promise<number> {
    let seeded = 0;
    for (const { moduleCode, moduleId } of moduleIds) {
      const template = DEFAULT_MODULE_PRICES[moduleCode];
      if (!template) {
        this.logger.warn(JSON.stringify({ event: 'module-price.seed.no-template', moduleCode }));
        continue;
      }
      if (await this.activeSheetFor(moduleCode)) continue;
      await this.setModulePrice({ ...template, moduleId, moduleCode }, actorId);
      seeded += 1;
    }
    this.logger.log(JSON.stringify({ event: 'module-price.seeded', seeded, actorId }));
    return seeded;
  }

  // ── Quoting ────────────────────────────────────────────────────────────

  /**
   * Price a module selection for a tier and a billing cycle.
   *
   * Order of operations, and it matters: per-module line items → tier
   * multiplier → cycle multiplier → cycle-length discount → discount code →
   * tax. Every intermediate is rounded to the currency's minor unit exactly
   * once, so the quote a customer is shown and the invoice they receive are
   * the same number.
   */
  async quote(
    command: BillingModuleQuoteRequest & { actorId?: string },
  ): Promise<BillingModuleQuote> {
    const cycleMonths = BILLING_CYCLE_MONTHS[command.billingCycle];
    if (cycleMonths === undefined) {
      throw new BadRequestException(`Unknown billing cycle ${String(command.billingCycle)}`);
    }
    const taxRate = new Decimal(command.taxRate ?? '0');
    if (taxRate.isNegative() || taxRate.greaterThan(100)) {
      throw new BadRequestException('taxRate must be between 0 and 100');
    }

    const sheets = await this.activeSheetsFor(command.modules.map((m) => m.moduleCode));
    const currency = firstCurrency(sheets) ?? 'USD';

    const breakdowns: BillingModuleQuoteBreakdown[] = [];
    const unpricedModuleCodes: string[] = [];
    let subtotal = new Decimal(0);
    let tierDiscount = new Decimal(0);

    for (const selection of command.modules) {
      const sheet = sheets.get(selection.moduleCode);
      if (!sheet) {
        // Not an error: a free/core module legitimately has no sheet. Naming
        // it is the difference between a quote that omits a module and a
        // quote that says it omitted one.
        unpricedModuleCodes.push(selection.moduleCode);
        continue;
      }
      const breakdown = priceModule(selection, sheet, command.tier);
      breakdowns.push(breakdown);
      subtotal = subtotal.plus(breakdown.subtotal);
      tierDiscount = tierDiscount.plus(breakdown.tierDiscount);
    }

    // A negotiated discount is the operator's own, not a code's: percentage off
    // the subtotal, then the fixed amount off what is left, floored at zero.
    // This is the ONLY implementation of that rule — a custom plan's stored
    // total and the builder's preview both come from here.
    const negotiatedPercent = new Decimal(command.negotiatedDiscountPercent ?? '0');
    if (negotiatedPercent.isNegative() || negotiatedPercent.greaterThan(100)) {
      throw new BadRequestException('negotiatedDiscountPercent must be between 0 and 100');
    }
    const negotiatedFixed = new Decimal(command.negotiatedDiscountAmount ?? '0');
    if (negotiatedFixed.isNegative()) {
      throw new BadRequestException('negotiatedDiscountAmount cannot be negative');
    }
    const negotiatedOffSubtotal = roundToCurrency(
      subtotal.times(negotiatedPercent).dividedBy(100),
      currency,
    );
    const negotiatedDiscountAmount = Decimal.min(
      subtotal,
      negotiatedOffSubtotal.plus(negotiatedFixed),
    );
    const monthlyTotal = subtotal.minus(negotiatedDiscountAmount);
    const cycleRate = new Decimal(BILLING_CYCLE_DISCOUNT_RATE[command.billingCycle]);
    const cycleGross = roundToCurrency(monthlyTotal.times(cycleMonths), currency);
    const cycleDiscountAmount = roundToCurrency(cycleGross.times(cycleRate), currency);
    let cycleTotal = cycleGross.minus(cycleDiscountAmount);

    let discountAmount = new Decimal(0);
    let discountDescription: string | undefined;
    let discountReason: BillingModuleQuote['discountReason'];

    if (command.discountCode) {
      if (!command.tenantId) {
        throw new BadRequestException(
          'A discount code can only be quoted for a tenant — supply tenantId with the quote',
        );
      }
      const validation = await this.discounts.validate(command.discountCode, command.tenantId, {
        subscriptionChange: command.subscriptionChange,
        orderAmount: cycleTotal,
      });
      if (validation.valid && validation.discountAmount) {
        discountAmount = roundToCurrency(validation.discountAmount, currency);
        discountDescription = validation.discountCode?.description ?? validation.message;
        cycleTotal = Decimal.max(new Decimal(0), cycleTotal.minus(discountAmount));
      } else {
        discountReason = validation.reason;
        discountDescription = validation.message;
      }
    }

    const tax = roundToCurrency(cycleTotal.times(taxRate).dividedBy(100), currency);

    return {
      modules: breakdowns,
      subtotal: subtotal.toString(),
      tierDiscount: tierDiscount.toString(),
      cycleDiscountAmount: cycleDiscountAmount.toString(),
      cycleDiscountPercent: cycleRate.times(100).toString(),
      discountCode: command.discountCode,
      discountDescription,
      discountAmount: discountAmount.toString(),
      discountReason,
      negotiatedDiscountAmount: negotiatedDiscountAmount.toString(),
      tax: tax.toString(),
      taxRate: taxRate.toString(),
      total: cycleTotal.plus(tax).toString(),
      monthlyTotal: monthlyTotal.toString(),
      annualTotal: roundToCurrency(
        monthlyTotal.times(12).times(new Decimal(1).minus(cycleRate)),
        currency,
      ).toString(),
      billingCycle: command.billingCycle,
      billingCycleMultiplier: cycleMonths,
      currency,
      tier: command.tier,
      calculatedAt: new Date().toISOString(),
      unpricedModuleCodes,
    };
  }
}

function isInForce(sheet: ModulePrice, at: Date): boolean {
  const from = new Date(sheet.effectiveFrom);
  const to = sheet.effectiveTo ? new Date(sheet.effectiveTo) : null;
  return sheet.isActive && at >= from && (to === null || at <= to);
}

/**
 * Every sheet in one quote must be denominated the same way; the first one
 * decides, and a mismatch is a data error the sheet writer prevents (a sheet
 * carries a single currency for all its metrics).
 */
function firstCurrency(sheets: Map<string, ModulePrice>): string | null {
  for (const sheet of sheets.values()) return sheet.currency;
  return null;
}

/** The wire shape of a sheet — the one place a row becomes a snapshot. */
export function toModulePriceSnapshot(sheet: ModulePrice): BillingModulePriceSnapshot {
  return {
    id: sheet.id,
    moduleId: sheet.moduleId,
    moduleCode: sheet.moduleCode,
    currency: sheet.currency,
    effectiveFrom: new Date(sheet.effectiveFrom).toISOString(),
    effectiveTo: sheet.effectiveTo ? new Date(sheet.effectiveTo).toISOString() : null,
    isActive: sheet.isActive,
    version: sheet.version,
    notes: sheet.notes,
    metrics: (sheet.metrics ?? []).map((metric) => ({
      metricType: metric.metricType,
      price: metric.price.toString(),
      description: metric.description ?? undefined,
      minQuantity: metric.minQuantity ?? undefined,
      maxQuantity: metric.maxQuantity ?? undefined,
      includedQuantity: metric.includedQuantity ?? undefined,
    })),
    tierMultipliers: (sheet.tierMultipliers ?? []).map((entry) => ({
      tier: entry.tier,
      multiplier: entry.multiplier.toString(),
    })),
    createdAt: new Date(sheet.createdAt).toISOString(),
    updatedAt: new Date(sheet.updatedAt).toISOString(),
    createdBy: sheet.createdBy,
    updatedBy: sheet.updatedBy,
  };
}
