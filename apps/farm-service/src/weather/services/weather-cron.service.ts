/**
 * Weather Cron Service
 * Zamanlanmış hava durumu senkronizasyonu
 *
 * Both cron methods iterate ALL tenant schemas with dedicated QueryRunner
 * per tenant to ensure proper search_path isolation.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { listTenantSchemas, requestContextStorage } from '@aquaculture/backend-common';
import { WeatherSettings } from '../entities/weather-settings.entity';
import { WeatherSyncService } from './weather-sync.service';

@Injectable()
export class WeatherCronService {
  private readonly logger = new Logger(WeatherCronService.name);

  constructor(
    private readonly syncService: WeatherSyncService,
    private readonly dataSource: DataSource,
  ) {}

  // getTenantSchemas replaced by listTenantSchemas from @aquaculture/backend-common

  /**
   * Her 15 dakikada bir çalışır
   * Her tenant'ın kendi sync_interval_minutes ayarına bakar
   * Iterates ALL tenant schemas with dedicated QueryRunner per tenant.
   */
  @Cron('*/15 * * * *', {
    name: 'weatherSync',
    timeZone: 'Europe/Istanbul',
  })
  async syncWeatherData(): Promise<void> {
    this.logger.log('Starting weather sync cron job');
    const startTime = Date.now();

    const tenantSchemas = await listTenantSchemas(this.dataSource);
    let syncedCount = 0;
    let skippedCount = 0;

    for (const schema of tenantSchemas) {
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();

      try {
        await queryRunner.query(`SET search_path TO "${schema}", farm, public`);

        // Get all enabled weather settings within this tenant schema
        const allSettings = await queryRunner.manager.find(WeatherSettings, {
          where: { enabled: true },
        });

        if (allSettings.length === 0) continue;

        const now = new Date();

        for (const settings of allSettings) {
          // Check if enough time has passed since last sync
          if (settings.lastSyncedAt) {
            const nextSyncAt = new Date(
              settings.lastSyncedAt.getTime() + settings.syncIntervalMinutes * 60 * 1000,
            );
            if (nextSyncAt > now) {
              skippedCount++;
              continue;
            }
          }

          try {
            const result = await requestContextStorage.run(
              { tenantId: settings.tenantId, schemaName: schema },
              () => this.syncService.syncTenant(settings.tenantId, settings.forecastDays),
            );
            syncedCount++;
            this.logger.log(
              `Synced tenant ${settings.tenantId} (schema: ${schema}): ${result.sites} sites, ` +
              `${result.totalWeather} weather rows, ${result.totalMarine} marine rows`,
            );
          } catch (err) {
            this.logger.error(
              `Failed to sync tenant ${settings.tenantId} in schema ${schema}: ${err}`,
            );
          }
        }
      } catch (err) {
        this.logger.error(
          `Weather sync failed for schema ${schema}: ${(err as Error).message}`,
        );
      } finally {
        await queryRunner.query('RESET search_path').catch(() => {});
        await queryRunner.release();
      }
    }

    const duration = Date.now() - startTime;
    this.logger.log(
      `Weather sync completed in ${duration}ms: ${syncedCount} synced, ${skippedCount} skipped`,
    );
  }

  /**
   * Her gece 03:00'da eski verileri temizle (30 günden eski)
   * Iterates ALL tenant schemas with dedicated QueryRunner per tenant.
   */
  @Cron('0 3 * * *', {
    name: 'weatherCleanup',
    timeZone: 'Europe/Istanbul',
  })
  async cleanupOldData(): Promise<void> {
    this.logger.log('Starting weather data cleanup');

    const tenantSchemas = await listTenantSchemas(this.dataSource);
    let totalWeatherDeleted = 0;
    let totalMarineDeleted = 0;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);

    for (const schema of tenantSchemas) {
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();

      try {
        await queryRunner.query(`SET search_path TO "${schema}", farm, public`);

        const weatherResult = await queryRunner.query(
          `DELETE FROM weather_observations WHERE observed_at < $1`,
          [cutoff],
        );
        const marineResult = await queryRunner.query(
          `DELETE FROM marine_observations WHERE observed_at < $1`,
          [cutoff],
        );

        const weatherDeleted = weatherResult?.[1] ?? 0;
        const marineDeleted = marineResult?.[1] ?? 0;
        totalWeatherDeleted += weatherDeleted;
        totalMarineDeleted += marineDeleted;

        if (weatherDeleted > 0 || marineDeleted > 0) {
          this.logger.log(
            `Weather cleanup schema ${schema}: ${weatherDeleted} weather, ${marineDeleted} marine rows deleted`,
          );
        }
      } catch (err) {
        this.logger.error(
          `Weather cleanup failed for schema ${schema}: ${(err as Error).message}`,
        );
      } finally {
        await queryRunner.query('RESET search_path').catch(() => {});
        await queryRunner.release();
      }
    }

    this.logger.log(
      `Weather cleanup completed: ${totalWeatherDeleted} weather, ${totalMarineDeleted} marine rows deleted`,
    );
  }
}
