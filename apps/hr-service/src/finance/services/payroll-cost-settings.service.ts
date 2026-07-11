/**
 * PayrollCostSettingsService — read/write access to the per-tenant
 * labour-cost settings row, and the HR-side currency resolver.
 *
 * The default currency is PROJECTED here from the farm finance_settings
 * SSoT by FinanceSettingsUpdatedConsumer; HR code paths that need a
 * default currency (employee creation, HR expense bookings) resolve it
 * through this service — never from a hardcoded literal.
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';

import {
  HR_PLATFORM_DEFAULT_CURRENCY,
  PayrollCostSettings,
} from '../entities/payroll-cost-settings.entity';

const CACHE_TTL_MS = 60_000;

@Injectable()
export class PayrollCostSettingsService {
  private readonly currencyCache = new Map<string, { value: string; expiresAt: number }>();

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /** Read-or-default (no row created) inside the caller's tenant context. */
  async getSettingsInTx(manager: EntityManager, tenantId: string): Promise<PayrollCostSettings> {
    const settings = await manager.findOne(PayrollCostSettings, { where: { tenantId } });
    if (settings) {
      return settings;
    }
    const defaults = new PayrollCostSettings();
    defaults.tenantId = tenantId;
    defaults.pensionFundPct = 0;
    defaults.socialInsurancePct = 0;
    defaults.medicalInsurancePct = 0;
    defaults.otherCostPct = 5;
    defaults.defaultCurrency = HR_PLATFORM_DEFAULT_CURRENCY;
    return defaults;
  }

  async getSettings(tenantId: string): Promise<PayrollCostSettings> {
    return runInTenantTransaction(this.dataSource, 'hr', tenantId, (queryRunner) =>
      this.getSettingsInTx(queryRunner.manager, tenantId),
    );
  }

  async getDefaultCurrencyInTx(manager: EntityManager, tenantId: string): Promise<string> {
    const cached = this.currencyCache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const settings = await this.getSettingsInTx(manager, tenantId);
    this.currencyCache.set(tenantId, {
      value: settings.defaultCurrency,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return settings.defaultCurrency;
  }

  invalidate(tenantId: string): void {
    this.currencyCache.delete(tenantId);
  }
}
