/**
 * TenantLocalizationProjectionListener — tenant saat dilimi projeksiyonu (W5).
 *
 * SSoT auth-service'tedir (`auth.tenants.settings.localization`); farm-service
 * o şemaya grant'i olmadığı ve yemleme cron'larının istek bağlamı bulunmadığı
 * için senkron sorgu ATAMAZ. Bunun yerine auth'un yazımla aynı transaction'da
 * outbox'a düşürdüğü `TenantUpdated` event'i yerel `tenant_localization`
 * satırına projekte edilir; `FeedingClockService` zon hiyerarşisinin orta
 * halkasını buradan okur.
 *
 * `TenantProvisioned` DİNLENMEZ: o event lokalizasyon taşımaz ve satırın
 * yokluğu zaten "henüz ayarlanmadı → UTC" anlamına gelir (varsayılan
 * kolonda). Boş bir satır yazmak hiçbir bilgi eklemezdi.
 *
 * Newest-wins + fail-closed: NATS at-least-once ve sırasız teslim
 * edebildiğinden yazım yalnız `sourceUpdatedAt` ilerlediğinde uygulanır;
 * doğrulanamayan zon REDDEDİLİR (eski değer korunur) — geçersiz bir zon
 * `Intl` tarafında RangeError üretip tenant'ın TÜM planlama işlerini
 * düşürürdü. Hata rethrow edilir ki NATS yeniden teslimle yakınsasın.
 *
 * @module FeedingProtocol/Listeners
 */
import { isValidBcp47Locale, isValidIanaTimeZone } from '@aquaculture/backend-common/utils';
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { HandlerOutcome, IEventBus, IEventHandler } from '@platform/event-bus';
import { requireTenantScope } from '@platform/event-contracts';
import type { BaseEvent, TenantUpdatedEvent } from '@platform/event-contracts';
import { DataSource } from 'typeorm';

@Injectable()
export class TenantLocalizationProjectionListener
  implements IEventHandler<BaseEvent>, OnModuleInit
{
  private readonly logger = new Logger(TenantLocalizationProjectionListener.name);

  constructor(
    private readonly dataSource: DataSource,
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus?: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn(
        'EVENT_BUS not available — tenant-localization projection subscription skipped. ' +
          'Feeding jobs fall back to UTC until the projection converges.',
      );
      return;
    }
    await this.eventBus.subscribeWildcard('TenantUpdated', this);
    this.logger.log('Subscribed to TenantUpdated for tenant-localization projection');
  }

  getEventType(): string {
    return 'TenantUpdated';
  }

  async handle(event: BaseEvent): Promise<HandlerOutcome> {
    // PLAT-MEDIUM-910: the tenancy scope is PARSED, not guarded. Skipping on a
    // malformed tenantId acked a poison message — the projection stayed stale
    // and nothing said so. `requireTenantScope` throws instead, so redelivery
    // (and the dead-letter lane behind it) sees the contract violation.
    const { tenantId } = requireTenantScope(event);

    const updated = event as TenantUpdatedEvent;
    // Lokalizasyon taşımayan TenantUpdated yayımları (isim/plan değişimi) bu
    // projeksiyonu ilgilendirmez — "uygulanmaz" bir ack'tir, hata değil.
    if (updated.timezone === undefined) {
      return HandlerOutcome.ack('TenantUpdated carries no localization');
    }

    if (!isValidIanaTimeZone(updated.timezone)) {
      // Zon çözülemiyorsa yazım REDDEDİLİR: yazsaydık cron `Intl` üzerinde
      // RangeError alır ve tenant'ın tüm yemleme işleri düşerdi. Sessiz UTC
      // ikamesi de yapılmaz — operatör yanlış saatte beslendiğini fark etmez.
      // PLAT-HIGH-902: yeniden teslim aynı çözülemez zonu getirir — kalıcı bir
      // payload kusuru, terminate. Böylece satır dead-letter defterinde görünür;
      // sessiz bir ack "projeksiyon güncel" derdi.
      return HandlerOutcome.terminate(
        `TenantUpdated carries an unresolvable IANA timezone for tenant ` +
          `${tenantId.substring(0, 8)}... — projection row left unchanged`,
      );
    }
    const locale = isValidBcp47Locale(updated.locale) ? updated.locale : null;

    const sourceUpdatedAt = new Date(event.timestamp);
    if (Number.isNaN(sourceUpdatedAt.getTime())) {
      return HandlerOutcome.terminate('TenantUpdated carries an unparseable timestamp');
    }

    try {
      await this.dataSource.query(
        `INSERT INTO farm.tenant_localization
           ("tenantId", "timezone", "locale", "sourceUpdatedAt", "updatedAt")
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT ("tenantId") DO UPDATE
           SET "timezone" = EXCLUDED."timezone",
               "locale" = COALESCE(EXCLUDED."locale", farm.tenant_localization."locale"),
               "sourceUpdatedAt" = EXCLUDED."sourceUpdatedAt",
               "updatedAt" = now()
         WHERE farm.tenant_localization."sourceUpdatedAt" IS NULL
            OR farm.tenant_localization."sourceUpdatedAt" < EXCLUDED."sourceUpdatedAt"`,
        [tenantId, updated.timezone, locale, sourceUpdatedAt],
      );
      return HandlerOutcome.ack();
    } catch (error) {
      this.logger.error(
        `Tenant-localization projection failed for tenant ${tenantId.substring(0, 8)}...: ` +
          `${(error as Error).message}`,
        (error as Error).stack,
      );
      // Rethrow → NATS yeniden teslim eder (upsert idempotent).
      throw error;
    }
  }
}
