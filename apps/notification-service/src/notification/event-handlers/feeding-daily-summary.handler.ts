import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import type { FeedingDailySummaryEvent } from '@platform/event-contracts';
import { Repository } from 'typeorm';

import { DeviceToken } from '../entities/device-token.entity';
import { NotificationChannel } from '../entities/notification-log.entity';
import { InAppNotificationService } from '../services/in-app.service';
import { NotificationDispatcherService } from '../services/notification-dispatcher.service';

// UUID v4 regex for tenant ID validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Bir tenant'ın günlük özet fan-out'u için üst sınır — kayıtlı cihaz kullanıcısı
 * bundan fazlaysa deterministik ilk N alınır ve WARN loglanır (sessiz kırpma yok).
 */
const MAX_SUMMARY_RECIPIENTS = 100;

/**
 * FeedingDailySummaryEventHandler (plan K-8c — 20:00 günlük özetin tüketicisi)
 *
 * farm-service'in 20:00 cron'u tenant başına TEK `FeedingDailySummary` durable
 * event'i yayınlar; bu handler onu kullanıcı-başına in-app + push bildirimine
 * çevirir.
 *
 * ALICI KARARI (belgeli): event tenant-seviyesidir, kullanıcı taşımaz.
 * notification-service'in sahip olduğu tek tenant-kullanıcı erişilebilirlik
 * dizini `device_tokens`'tır (AquaMobil saha uygulamasına kayıtlı operatörler) —
 * alıcı kümesi = tenant'ın DISTINCT cihaz-token kullanıcıları. Rol dizini bu
 * serviste yoktur ve burada icat edilmez; rol-bazlı yönlendirme gerektiğinde
 * alert-engine eskalasyon politikaları kullanılır.
 *
 * İDEMPOTENCY: kullanıcı başına tek deterministik deliveryId
 * (`feeding-summary:{tenant}:{planDate}:{user}`) hem push makbuzunun hem de
 * in-app satırının kimliğidir. Push makbuzu ve notification_logs'un kısmi
 * unique index'i birbirinden bağımsız olarak aynı kimliğe yakınsar; bu nedenle
 * push hatasından sonraki retry ya da eşzamanlı tüketim ikinci in-app satırı
 * üretemez.
 */
@Injectable()
export class FeedingDailySummaryEventHandler
  implements IEventHandler<FeedingDailySummaryEvent>, OnModuleInit
{
  private readonly logger = new Logger(FeedingDailySummaryEventHandler.name);

  constructor(
    private readonly dispatcher: NotificationDispatcherService,
    @Inject(InAppNotificationService)
    private readonly inAppService: Pick<InAppNotificationService, 'ensureNotification'>,
    @InjectRepository(DeviceToken)
    private readonly deviceTokenRepository: Repository<DeviceToken>,
    @Inject('EVENT_BUS')
    private readonly eventBus: Pick<IEventBus, 'subscribeWildcard'>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.eventBus.subscribeWildcard('FeedingDailySummary', this);
    this.logger.log(
      'Subscribed to FeedingDailySummary events for daily feeding digests (cross-tenant wildcard)',
    );
  }

  getEventType(): string {
    return 'FeedingDailySummary';
  }

  async handle(event: FeedingDailySummaryEvent): Promise<void> {
    if (!event.tenantId || !UUID_REGEX.test(event.tenantId)) {
      this.logger.error(
        'FeedingDailySummary event has invalid or missing tenantId. ' +
          'Skipping to prevent cross-tenant notification leakage.',
      );
      return;
    }

    const recipients = await this.resolveRecipients(event.tenantId);
    if (recipients.length === 0) {
      this.logger.debug(
        `No registered device users for tenant ${event.tenantId.substring(0, 8)}... — ` +
          'daily feeding summary has no reachable recipients.',
      );
      return;
    }

    const completionRate =
      event.unitsPlanned > 0
        ? ((event.unitsCompleted / event.unitsPlanned) * 100).toFixed(0)
        : '100';
    const title = `Günlük yemleme özeti — ${event.planDate}`;
    const body =
      `${event.unitsCompleted}/${event.unitsPlanned} ünite tamamlandı (%${completionRate}), ` +
      `${event.actualTotalKg.toFixed(1)} kg atıldı (plan ${event.plannedTotalKg.toFixed(1)} kg)` +
      (event.underfedUnitCount > 0 ? `, ${event.underfedUnitCount} ünite az beslendi` : '') +
      (event.missedMealCount > 0 ? `, ${event.missedMealCount} öğün kaçırıldı` : '');

    const deliveryFailures: string[] = [];
    for (const { userId, token } of recipients) {
      const deliveryId = `feeding-summary:${event.tenantId}:${event.planDate}:${userId}`;
      try {
        await this.dispatcher.dispatchCommandNotification({
          tenantId: event.tenantId,
          channel: NotificationChannel.PUSH,
          recipient: token,
          recipientLogRef: `userId:${userId}`,
          deliveryId,
          requestReference: deliveryId,
          source: 'notification-service.feeding-daily-summary-handler',
          subject: title,
          message: body,
          // MT-HIGH-050: intended-recipient stamp — paylaşılan cihazda başka
          // oturum açıksa SW push'u düşürür.
          pushData: { userId },
        });
      } catch (error) {
        // Push denemesini dispatcher'ın retry makinesi devralır; in-app aşağıda
        // yine yazılır.
        this.logger.warn(
          `Daily summary push dispatch failed for user ${userId.substring(0, 8)}...: ` +
            `${(error as Error).message}`,
        );
      }

      try {
        await this.inAppService.ensureNotification({
          tenantId: event.tenantId,
          userId,
          title,
          body,
          deliveryId,
          data: {
            type: 'FeedingDailySummary',
            planDate: event.planDate,
            unitsPlanned: event.unitsPlanned,
            unitsCompleted: event.unitsCompleted,
            unitsSkipped: event.unitsSkipped,
            plannedTotalKg: event.plannedTotalKg,
            actualTotalKg: event.actualTotalKg,
            underfedUnitCount: event.underfedUnitCount,
            missedMealCount: event.missedMealCount,
          },
        });
      } catch (error) {
        this.logger.error(
          `Daily summary in-app write failed for user ${userId.substring(0, 8)}...: ` +
            `${(error as Error).message}`,
        );
        deliveryFailures.push(`${userId.substring(0, 8)}: ${(error as Error).message}`);
      }
    }

    if (deliveryFailures.length > 0) {
      throw new Error(
        `FeedingDailySummary in-app fan-out failed for ${deliveryFailures.length}/` +
          `${recipients.length} recipient(s): ${deliveryFailures.join(' | ')}`,
      );
    }

    this.logger.debug(
      `Daily feeding summary fanned out to ${recipients.length} user(s) ` +
        `for tenant ${event.tenantId.substring(0, 8)}...`,
    );
  }

  /**
   * Tenant'ın kayıtlı cihaz kullanıcıları — kullanıcı başına EN GÜNCEL token
   * (lastSeenAt DESC). Deterministik sıralı; MAX_SUMMARY_RECIPIENTS üstü WARN'la
   * kırpılır.
   */
  private async resolveRecipients(
    tenantId: string,
  ): Promise<Array<{ userId: string; token: string }>> {
    const rows: Array<{ userId: string; token: string }> = await this.deviceTokenRepository
      .createQueryBuilder('t')
      .select('DISTINCT ON (t.user_id) t.user_id', 'userId')
      .addSelect('t.token', 'token')
      .where('t.tenant_id = :tenantId', { tenantId })
      .orderBy('t.user_id', 'ASC')
      .addOrderBy('t.last_seen_at', 'DESC', 'NULLS LAST')
      .getRawMany();

    if (rows.length > MAX_SUMMARY_RECIPIENTS) {
      this.logger.warn(
        `Tenant ${tenantId.substring(0, 8)}... has ${rows.length} device users; ` +
          `daily summary capped at ${MAX_SUMMARY_RECIPIENTS} recipients.`,
      );
      return rows.slice(0, MAX_SUMMARY_RECIPIENTS);
    }
    return rows;
  }
}
