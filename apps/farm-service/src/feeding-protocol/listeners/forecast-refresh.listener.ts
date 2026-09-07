/**
 * ForecastRefreshListener — D-6 event-driven snapshot yenileme.
 *
 * "İnteraktiflik" 07:00 cron'unu bekleMEZ: stok girişi/düzeltmesi
 * (StockMovementRecorded in|adjustment — feed), yem geçişi
 * (FeedTypeTransitioned) ve atama yaşam döngüsü (FeedingProtocolAssigned /
 * FeedingProtocolAssignmentPaused) snapshot'ı tenant başına ~60sn debounce
 * ile yeniden hesaplatır — bugün gelen yem teslimatı dakikalar içinde
 * grafiğe yansır. Debounce TRAILING'dir: pencere içindeki olay patlaması
 * TEK yeniden hesapta birleşir (event başına O(N×H) çalıştırılmaz).
 *
 * OUT/waste hareketleri kasıtlı olarak dinlenmez: öğün tüketimi sürekli
 * OUT üretir; kademeli drift'i 07:00 cron'u zaten kapatır, burada dinlemek
 * her öğünde tam yeniden hesap demek olurdu.
 *
 * ACL notu (ADR-015): kendi subject'lerimize JetStream aboneliği mevcut
 * farm_service izinleriyle ($JS.API.> + _INBOX.>) çalışır —
 * sensor-temperature-projection.listener emsali; services.yaml değişmez.
 *
 * @module FeedingProtocol/Listeners
 */
import { isValidUUID } from '@aquaculture/backend-common/database';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { IEventBus, HandlerOutcome } from '@platform/event-bus';
import type { BaseEvent, StockMovementRecordedEvent } from '@platform/event-contracts';

import { ProtocolFeedForecastService } from '../services/protocol-feed-forecast.service';

/** Tenant başına birleştirme penceresi (plan D-6: ~60sn). */
export const FORECAST_REFRESH_DEBOUNCE_MS = 60_000;

const SUBSCRIBED_EVENT_TYPES = [
  'StockMovementRecorded',
  'FeedTypeTransitioned',
  'FeedingProtocolAssigned',
  'FeedingProtocolAssignmentPaused',
] as const;

@Injectable()
export class ForecastRefreshListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ForecastRefreshListener.name);
  private readonly pendingByTenant = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly forecastService: ProtocolFeedForecastService,
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus?: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn(
        'EVENT_BUS yok — forecast event-driven yenileme aboneliği atlandı; ' +
          'snapshot tazeliği 07:00 cron + manuel refresh ile sınırlı kalır.',
      );
      return;
    }
    for (const eventType of SUBSCRIBED_EVENT_TYPES) {
      await this.eventBus.subscribeWildcard(eventType, {
        getEventType: (): string => eventType,
        handle: async (event: BaseEvent): Promise<HandlerOutcome> => this.onEvent(event),
      });
    }
    this.logger.log(`Forecast yenileme aboneliği kuruldu: ${SUBSCRIBED_EVENT_TYPES.join(', ')}`);
  }

  onModuleDestroy(): void {
    for (const timer of this.pendingByTenant.values()) clearTimeout(timer);
    this.pendingByTenant.clear();
  }

  /** SAF karar: bu event snapshot'ı tazelemeli mi? (spec pinli) */
  shouldRefresh(event: BaseEvent): boolean {
    if (!isValidUUID(event.tenantId ?? '')) return false;
    if (event.eventType === 'StockMovementRecorded') {
      const movement = event as StockMovementRecordedEvent;
      // Yalnız stok ARTIRAN/AYARLAYAN feed hareketleri — OUT tüketimi cron kapatır.
      return (
        movement.itemType === 'feed' &&
        (movement.movementType === 'in' || movement.movementType === 'adjustment')
      );
    }
    return true;
  }

  /**
   * Debounce, then refresh. The refresh itself runs detached from the delivery
   * on purpose (PLAT-HIGH-902 R7): its failure is not data loss — the 07:00
   * cron regenerates the same snapshot — so the trigger is acknowledged once
   * the debounce window is armed rather than held open for up to a minute
   * against the consumer's ack_wait.
   */
  async onEvent(event: BaseEvent): Promise<HandlerOutcome> {
    if (!this.shouldRefresh(event)) return HandlerOutcome.ack();
    const tenantId = event.tenantId as string;
    if (this.pendingByTenant.has(tenantId)) return HandlerOutcome.ack(); // pencere zaten açık — birleştir
    const timer = setTimeout(() => {
      this.pendingByTenant.delete(tenantId);
      void this.forecastService.refreshTenant(tenantId).catch((error: unknown) => {
        // Yeniden hesap kaybı veri kaybı değildir: 07:00 cron'u aynı satırı
        // yeniden üretir — logla, NATS redelivery fırtınası başlatma.
        this.logger.error(
          `Event-driven forecast yenileme başarısız (tenant=${tenantId}): ${(error as Error).message}`,
        );
      });
    }, FORECAST_REFRESH_DEBOUNCE_MS);
    // Testlerde/kapanışta process'i açık tutmasın.
    timer.unref?.();
    this.pendingByTenant.set(tenantId, timer);
    return HandlerOutcome.ack();
  }
}
