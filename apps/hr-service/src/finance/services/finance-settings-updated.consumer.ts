/**
 * FinanceSettingsUpdatedConsumer
 *
 * Projects the tenant currency SSoT (farm finance_settings) into
 * hr_payroll_cost_settings.defaultCurrency whenever farm-service emits
 * FinanceSettingsUpdated. This keeps both finance tabs reporting in ONE
 * tenant-chosen currency without hr-service holding a second editable
 * source of truth — the projection is the only writer of that column
 * besides the migration default.
 *
 * Fail-closed posture: payload is validated against the AJV wire schema
 * before any write (same trust-boundary rule as the farm NATS bridge);
 * an invalid or cross-tenant-shaped payload is dropped with a warn.
 *
 * Ordered + idempotent: each apply records the source event timestamp in
 * `currencyProjectedAt`; an event whose timestamp is not newer than the
 * watermark is a no-op, so an out-of-order NATS redelivery can never
 * regress the tenant currency to a stale value.
 */
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import { validateFinanceEvent } from '@platform/event-contracts';
import type { FinanceSettingsUpdatedEvent } from '@platform/event-contracts';

import {
  HR_PLATFORM_DEFAULT_CURRENCY,
  PayrollCostSettings,
} from '../entities/payroll-cost-settings.entity';
import { PayrollCostSettingsService } from './payroll-cost-settings.service';

@Injectable()
export class FinanceSettingsUpdatedConsumer
  implements IEventHandler<FinanceSettingsUpdatedEvent>, OnModuleInit
{
  private readonly logger = new Logger(FinanceSettingsUpdatedConsumer.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly settingsService: PayrollCostSettingsService,
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus | undefined,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn(
        'EVENT_BUS unavailable — FinanceSettingsUpdated projection inactive (dev harness without NATS)',
      );
      return;
    }
    await this.eventBus.subscribeWildcard('FinanceSettingsUpdated', this);
    this.logger.log(
      'Subscribed to FinanceSettingsUpdated — projecting tenant default currency into hr_payroll_cost_settings',
    );
  }

  getEventType(): string {
    return 'FinanceSettingsUpdated';
  }

  async handle(event: FinanceSettingsUpdatedEvent): Promise<void> {
    const verdict = validateFinanceEvent('FinanceSettingsUpdated', event);
    if (!verdict.valid) {
      this.logger.warn(`Dropping invalid FinanceSettingsUpdated payload: ${verdict.errors}`);
      return;
    }

    const { tenantId, defaultCurrency } = event;
    const eventTimestamp = new Date(event.timestamp);
    const applied = await runInTenantTransaction(
      this.dataSource,
      'hr',
      tenantId,
      async (queryRunner) => {
        const manager = queryRunner.manager;
        let settings = await manager.findOne(PayrollCostSettings, {
          where: { tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (
          settings?.currencyProjectedAt &&
          eventTimestamp <= settings.currencyProjectedAt
        ) {
          // Stale or out-of-order redelivery — the watermark already
          // reflects a newer (or equal) currency decision.
          return false;
        }
        if (!settings) {
          settings = manager.create(PayrollCostSettings, {
            tenantId,
            pensionFundPct: 0,
            socialInsurancePct: 0,
            medicalInsurancePct: 0,
            otherCostPct: 5,
            defaultCurrency: HR_PLATFORM_DEFAULT_CURRENCY,
          });
        }
        settings.defaultCurrency = defaultCurrency;
        settings.currencyProjectedAt = eventTimestamp;
        await manager.save(settings);
        return true;
      },
    );
    if (!applied) {
      this.logger.debug(
        `Skipped stale FinanceSettingsUpdated for tenant ${tenantId.slice(0, 8)}… (watermark newer)`,
      );
      return;
    }
    this.settingsService.invalidate(tenantId);
    this.logger.log(
      `Projected default currency ${defaultCurrency} for tenant ${tenantId.slice(0, 8)}…`,
    );
  }
}
