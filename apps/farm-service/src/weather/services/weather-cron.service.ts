/**
 * Weather Cron Service
 * Zamanlanmış hava durumu senkronizasyonu
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WeatherSettings } from '../entities/weather-settings.entity';
import { WeatherSyncService } from './weather-sync.service';

@Injectable()
export class WeatherCronService {
  private readonly logger = new Logger(WeatherCronService.name);

  constructor(
    @InjectRepository(WeatherSettings)
    private readonly settingsRepo: Repository<WeatherSettings>,
    private readonly syncService: WeatherSyncService,
  ) {}

  /**
   * Her 15 dakikada bir çalışır
   * Her tenant'ın kendi sync_interval_minutes ayarına bakar
   */
  @Cron('*/15 * * * *', {
    name: 'weatherSync',
    timeZone: 'Europe/Istanbul',
  })
  async syncWeatherData(): Promise<void> {
    this.logger.log('Starting weather sync cron job');
    const startTime = Date.now();

    try {
      // Get all enabled tenant settings
      const allSettings = await this.settingsRepo.find({
        where: { enabled: true },
      });

      // If no settings exist yet, nothing to sync
      if (allSettings.length === 0) {
        this.logger.debug('No enabled weather settings found, skipping');
        return;
      }

      const now = new Date();
      let syncedCount = 0;
      let skippedCount = 0;

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
          const result = await this.syncService.syncTenant(
            settings.tenantId,
            settings.forecastDays,
          );
          syncedCount++;
          this.logger.log(
            `Synced tenant ${settings.tenantId}: ${result.sites} sites, ` +
            `${result.totalWeather} weather rows, ${result.totalMarine} marine rows`,
          );
        } catch (err) {
          this.logger.error(`Failed to sync tenant ${settings.tenantId}: ${err}`);
        }
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `Weather sync completed in ${duration}ms: ${syncedCount} synced, ${skippedCount} skipped`,
      );
    } catch (err) {
      this.logger.error(`Weather sync cron failed: ${err}`);
    }
  }

  /**
   * Her gece 03:00'da eski verileri temizle (30 günden eski)
   */
  @Cron('0 3 * * *', {
    name: 'weatherCleanup',
    timeZone: 'Europe/Istanbul',
  })
  async cleanupOldData(): Promise<void> {
    this.logger.log('Starting weather data cleanup');
    try {
      const result = await this.syncService.cleanupOldData(30);
      this.logger.log(
        `Weather cleanup: ${result.weatherDeleted} weather, ${result.marineDeleted} marine rows deleted`,
      );
    } catch (err) {
      this.logger.error(`Weather cleanup failed: ${err}`);
    }
  }
}
