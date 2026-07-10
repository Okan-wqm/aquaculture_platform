/**
 * FinanceSettingsService — the tenant currency SSoT resolver.
 *
 * Every farm-service code path that needs a default currency resolves it
 * HERE (cached read of finance_settings.defaultCurrency, falling back to
 * PLATFORM_DEFAULT_CURRENCY for tenants that have not persisted a row
 * yet). Hardcoded ISO-currency literals in command handlers are banned
 * by the finance-currency-ssot invariant spec — this service is the only
 * legitimate defaulting path.
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { runInTenantRead } from '@aquaculture/backend-common/database';

import {
  FinanceSettings,
  PLATFORM_DEFAULT_CURRENCY,
} from '../entities/finance-settings.entity';

const CACHE_TTL_MS = 60_000;

interface CachedSettings {
  defaultCurrency: string;
  fiscalYearStartMonth: number;
  expiresAt: number;
}

@Injectable()
export class FinanceSettingsService {
  private readonly cache = new Map<string, CachedSettings>();

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /** Resolve the tenant's default currency (cached, fail-open to platform default). */
  async getDefaultCurrency(tenantId: string): Promise<string> {
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.defaultCurrency;
    }
    const settings = await runInTenantRead(this.dataSource, 'farm', tenantId, (queryRunner) =>
      queryRunner.manager.findOne(FinanceSettings, { where: { tenantId } }),
    );
    const resolved: CachedSettings = {
      defaultCurrency: settings?.defaultCurrency ?? PLATFORM_DEFAULT_CURRENCY,
      fiscalYearStartMonth: settings?.fiscalYearStartMonth ?? 1,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };
    this.cache.set(tenantId, resolved);
    return resolved.defaultCurrency;
  }

  /**
   * Variant for callers already inside a tenant transaction — reads
   * through the caller's manager so the settings row a preceding write
   * created is visible.
   */
  async getDefaultCurrencyInTx(manager: EntityManager, tenantId: string): Promise<string> {
    const settings = await manager.findOne(FinanceSettings, { where: { tenantId } });
    return settings?.defaultCurrency ?? PLATFORM_DEFAULT_CURRENCY;
  }

  /** Read-or-default the full settings shape (no row is created). */
  async getSettings(tenantId: string): Promise<FinanceSettings> {
    const settings = await runInTenantRead(this.dataSource, 'farm', tenantId, (queryRunner) =>
      queryRunner.manager.findOne(FinanceSettings, { where: { tenantId } }),
    );
    if (settings) {
      return settings;
    }
    const defaults = new FinanceSettings();
    defaults.tenantId = tenantId;
    defaults.defaultCurrency = PLATFORM_DEFAULT_CURRENCY;
    defaults.fiscalYearStartMonth = 1;
    return defaults;
  }

  /** Called by the update handler after a settings write commits. */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}
