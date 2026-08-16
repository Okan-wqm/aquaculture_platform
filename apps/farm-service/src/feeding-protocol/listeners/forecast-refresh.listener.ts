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
import { isValidUUID, runInTenantRead } from '@aquaculture/backend-common/database';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { IEventBus } from '@platform/event-bus';
import type {
  BaseEvent,
  FeedingProtocolAssignedEvent,
  FeedingProtocolAssignmentPausedEvent,
  FeedTypeTransitionedEvent,
  StockMovementRecordedEvent,
} from '@platform/event-contracts';
import { DataSource } from 'typeorm';
import { FEEDING_FORECAST_REFRESH_EVENT_AUTHORITY } from '@aquaculture/feeding-contracts';

import {
  FEEDING_OPERATION_COMMAND_PORT,
  type FeedingOperationCommandPort,
} from '../feeding-operation-command.port';

/** Tenant başına birleştirme penceresi (plan D-6: ~60sn). */
export const FORECAST_REFRESH_DEBOUNCE_MS = 60_000;

type ForecastRefreshCommandPort = Pick<FeedingOperationCommandPort, 'refreshForecast'>;

@Injectable()
export class ForecastRefreshListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ForecastRefreshListener.name);
  private readonly pendingByTarget = new Map<string, NodeJS.Timeout>();

  constructor(
    @Inject(FEEDING_OPERATION_COMMAND_PORT)
    private readonly operationPort: ForecastRefreshCommandPort,
    @InjectDataSource() private readonly dataSource: DataSource,
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
    for (const eventType of FEEDING_FORECAST_REFRESH_EVENT_AUTHORITY.eventTypes) {
      await this.eventBus.subscribeWildcard(eventType, {
        getEventType: (): string => eventType,
        handle: async (event: BaseEvent): Promise<void> => this.onEvent(event),
      });
    }
    this.logger.log(
      `Forecast yenileme aboneliği kuruldu: ${FEEDING_FORECAST_REFRESH_EVENT_AUTHORITY.eventTypes.join(', ')}`,
    );
  }

  onModuleDestroy(): void {
    for (const timer of this.pendingByTarget.values()) clearTimeout(timer);
    this.pendingByTarget.clear();
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

  async onEvent(event: BaseEvent): Promise<void> {
    if (!this.shouldRefresh(event)) return;
    const tenantId = event.tenantId as string;
    const siteId = await this.resolveSiteId(event);
    const targetKey = `${tenantId}:${siteId}`;
    if (this.pendingByTarget.has(targetKey)) return; // pencere zaten açık — birleştir
    const timer = setTimeout(() => {
      this.pendingByTarget.delete(targetKey);
      void this.operationPort
        .refreshForecast({
          tenantId,
          siteId,
          actorId: event.userId ?? 'event-bus:feeding-forecast',
          requestId: event.eventId,
          emitCoverageEvents: false,
        })
        .catch((error: unknown) => {
          // Yeniden hesap kaybı veri kaybı değildir: 07:00 cron'u aynı satırı
          // yeniden üretir — logla, NATS redelivery fırtınası başlatma.
          this.logger.error(
            `Event-driven forecast yenileme başarısız (tenant=${tenantId}): ${(error as Error).message}`,
          );
        });
    }, FORECAST_REFRESH_DEBOUNCE_MS);
    // Testlerde/kapanışta process'i açık tutmasın.
    timer.unref?.();
    this.pendingByTarget.set(targetKey, timer);
  }

  private async resolveSiteId(event: BaseEvent): Promise<string> {
    if (event.eventType === 'FeedingProtocolAssigned') {
      const siteId = (event as FeedingProtocolAssignedEvent).siteId;
      if (isValidUUID(siteId)) return siteId;
      throw new Error(`FeedingProtocolAssigned ${event.eventId} has no valid Site identity`);
    }
    return runInTenantRead(this.dataSource, 'farm', event.tenantId, async (queryRunner) => {
      if (event.eventType === 'StockMovementRecorded') {
        const movement = event as StockMovementRecordedEvent;
        const locationId = movement.toLocationId ?? movement.fromLocationId;
        if (!locationId) {
          throw new Error(`Stock movement ${event.eventId} has no storage location identity`);
        }
        const rows: Array<{ siteId: string | null }> = await queryRunner.manager.query(
          `SELECT site_id AS "siteId" FROM "storage_locations"
            WHERE id = $1::uuid AND tenant_id = $2::uuid`,
          [locationId, event.tenantId],
        );
        const siteId = rows[0]?.siteId;
        if (!siteId) throw new Error(`Storage location ${locationId} has no governed Site`);
        return siteId;
      }
      const assignmentId =
        event.eventType === 'FeedTypeTransitioned'
          ? (event as FeedTypeTransitionedEvent).assignmentId
          : (event as FeedingProtocolAssignmentPausedEvent).assignmentId;
      const rows: Array<{ siteId: string }> = await queryRunner.manager.query(
        `SELECT "siteId" FROM "feeding_protocol_assignments"
          WHERE id = $1::uuid AND "tenantId" = $2::uuid`,
        [assignmentId, event.tenantId],
      );
      const siteId = rows[0]?.siteId;
      if (!siteId) throw new Error(`Feeding assignment ${assignmentId} has no governed Site`);
      return siteId;
    });
  }
}
