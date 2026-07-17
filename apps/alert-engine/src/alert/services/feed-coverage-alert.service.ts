/**
 * FeedCoverageAlertService (Faz 7, plan §6)
 *
 * 07:00 kapsama süpürmesinin durable sinyallerini eskalasyonlu incident'lara
 * çevirir:
 *
 *  - `FeedStockoutForecast`: daysOfCover ≤ 3 → CRITICAL; ≤ tedarik süresi →
 *    WARNING; tedarik süresinden uzaktaki tükeniş incident ÜRETMEZ (120 günlük
 *    ufukta her tükeniş sinyallenir — aksiyon penceresi dışındakiler forecast
 *    grafiğinin işidir, alert gürültüsü değil; karar burada BELGELİ).
 *  - `FeedTransitionUpcoming`: yalnız kapsama açığı taşıyanlar (shortfallDays)
 *    incident olur — açıksız geçiş bilgisi MealBoard/zaman çizelgesinin işi.
 *
 * Dedup kimliği kapsam bazlıdır (LowStock/FCR emsali): aynı yem/site kapsamı
 * her sabah TEK açık incident'ı besler, taşkın üretmez.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FEED_STOCKOUT_CRITICAL_DAYS } from '@platform/event-contracts';
import type {
  FeedStockoutForecastEvent,
  FeedTransitionUpcomingEvent,
} from '@platform/event-contracts';

import { AlertSeverity } from '../../database/entities/alert-rule.entity';
import { AlertHistory } from '../entities/alert-history.entity';
import { FarmSignalIncidentService } from './farm-signal-incident.service';

/**
 * SAF eşik kararı — spec pinler; null = incident üretme. Kritik taban,
 * event'in yanındaki paylaşılan sabittir (warehouse-summary ile tek SSoT);
 * tedarik süresi kısaysa bile ≤FEED_STOCKOUT_CRITICAL_DAYS gün kritiktir.
 */
export function stockoutSeverityFor(
  daysOfCover: number,
  procurementLeadTimeDays: number,
): AlertSeverity | null {
  if (daysOfCover <= FEED_STOCKOUT_CRITICAL_DAYS) return AlertSeverity.CRITICAL;
  if (daysOfCover <= procurementLeadTimeDays) return AlertSeverity.WARNING;
  return null;
}

@Injectable()
export class FeedCoverageAlertService {
  private readonly logger = new Logger(FeedCoverageAlertService.name);

  constructor(
    @InjectRepository(AlertHistory)
    private readonly historyRepository: Repository<AlertHistory>,
    @Inject(FarmSignalIncidentService)
    private readonly farmSignalIncident: Pick<FarmSignalIncidentService, 'ensureIncident'>,
  ) {}

  async recordStockoutForecast(event: FeedStockoutForecastEvent): Promise<void> {
    const severity = stockoutSeverityFor(event.daysOfCover, event.procurementLeadTimeDays);
    if (severity === null) {
      this.logger.debug(
        `Stockout ufukta ama aksiyon penceresi dışında — incident yok ` +
          `(feed=${event.feedCode} daysOfCover=${event.daysOfCover})`,
      );
      return;
    }
    const ruleId = `system:feed-stockout:${event.siteScopeKey}:${event.feedId}`;
    const ruleName = 'Feed Stockout Forecast';
    const triggeredAt = new Date(event.timestamp);
    const message =
      `${event.feedCode} stoğu ${event.daysOfCover} gün içinde tükeniyor ` +
      `(tükeniş: ${event.stockoutDate}, tedarik süresi: ${event.procurementLeadTimeDays} gün` +
      (event.reorderDate ? `, önerilen sipariş: ${event.reorderDate}` : '') +
      `)`;

    const history = await this.historyRepository.save(
      this.historyRepository.create({
        ruleId,
        ruleName,
        tenantId: event.tenantId,
        severity,
        message,
        triggeringData: {
          source: 'farm.feeding.stockCoverage',
          siteScopeKey: event.siteScopeKey,
          feedId: event.feedId,
          feedCode: event.feedCode,
          daysOfCover: event.daysOfCover,
          stockoutDate: event.stockoutDate,
          reorderDate: event.reorderDate ?? null,
          procurementLeadTimeDays: event.procurementLeadTimeDays,
          correlationId: event.correlationId,
        },
        triggeredAt,
      }),
    );

    await this.farmSignalIncident.ensureIncident({
      tenantId: event.tenantId,
      ruleId,
      title: `${ruleName}: ${event.feedCode}`,
      description: message,
      severity,
      triggeredAt,
      signalLabel: 'feed-stockout',
      triggerData: {
        historyId: history.id,
        feedId: event.feedId,
        siteScopeKey: event.siteScopeKey,
        daysOfCover: event.daysOfCover,
        stockoutDate: event.stockoutDate,
        triggeredAt,
      },
    });
  }

  async recordTransitionGap(event: FeedTransitionUpcomingEvent): Promise<void> {
    if (event.shortfallDays === undefined || event.shortfallDays <= 0) {
      return; // Açıksız geçiş bilgi sinyalidir — incident değil (belgeli).
    }
    const ruleId = `system:feed-transition-gap:${event.unitId}:${event.toFeedId}`;
    const ruleName = 'Feed Transition Coverage Gap';
    const triggeredAt = new Date(event.timestamp);
    const message =
      `${event.unitCode} ünitesi ${event.daysFromNow} gün sonra yeni yeme geçiyor ` +
      `(${event.estimatedDate}) ama hedef yemin stoğu ${event.shortfallDays} gün YETMİYOR — ` +
      `tedarik penceresi kaçırılmak üzere`;

    const history = await this.historyRepository.save(
      this.historyRepository.create({
        ruleId,
        ruleName,
        tenantId: event.tenantId,
        severity: AlertSeverity.WARNING,
        message,
        triggeringData: {
          source: 'farm.feeding.stockCoverage',
          siteScopeKey: event.siteScopeKey,
          unitId: event.unitId,
          unitCode: event.unitCode,
          fromFeedId: event.fromFeedId,
          toFeedId: event.toFeedId,
          estimatedDate: event.estimatedDate,
          daysFromNow: event.daysFromNow,
          shortfallDays: event.shortfallDays,
          correlationId: event.correlationId,
        },
        triggeredAt,
      }),
    );

    await this.farmSignalIncident.ensureIncident({
      tenantId: event.tenantId,
      ruleId,
      title: `${ruleName}: ${event.unitCode}`,
      description: message,
      severity: AlertSeverity.WARNING,
      triggeredAt,
      signalLabel: 'feed-transition-gap',
      triggerData: {
        historyId: history.id,
        unitId: event.unitId,
        toFeedId: event.toFeedId,
        estimatedDate: event.estimatedDate,
        shortfallDays: event.shortfallDays,
        triggeredAt,
      },
    });
  }
}
