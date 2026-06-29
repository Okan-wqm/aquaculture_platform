/**
 * Weather Sync Service
 * Open-Meteo verilerini DB'ye senkronize eder
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { WeatherObservation, WeatherDataType } from '../entities/weather-observation.entity';
import { MarineObservation } from '../entities/marine-observation.entity';
import { WeatherSettings } from '../entities/weather-settings.entity';
import { Site } from '../../site/entities/site.entity';
import { OpenMeteoService, WeatherHourlyData, MarineHourlyData } from './open-meteo.service';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';

const RATE_LIMIT_DELAY = 200; // ms between site requests

@Injectable()
export class WeatherSyncService {
  private readonly logger = new Logger(WeatherSyncService.name);

  constructor(
    @InjectRepository(WeatherObservation)
    private readonly weatherRepo: Repository<WeatherObservation>,
    @InjectRepository(MarineObservation)
    private readonly marineRepo: Repository<MarineObservation>,
    @InjectRepository(WeatherSettings)
    private readonly settingsRepo: Repository<WeatherSettings>,
    @InjectRepository(Site)
    private readonly siteRepo: Repository<Site>,
    private readonly openMeteo: OpenMeteoService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Sync weather data for a single site
   */
  async syncSite(tenantId: string, siteId: string, forecastDays: number = 7): Promise<{ weather: number; marine: number }> {
    const site = await this.siteRepo.findOne({ where: { id: siteId, tenantId, isActive: true } });
    if (!site?.location?.latitude || !site?.location?.longitude) {
      this.logger.debug(`Site ${siteId} has no valid coordinates, skipping`);
      return { weather: 0, marine: 0 };
    }

    const { latitude, longitude } = site.location;
    const now = new Date();

    // Fetch both APIs in parallel
    const [weatherData, marineData] = await Promise.all([
      this.openMeteo.fetchWeatherData(latitude, longitude, forecastDays, 1),
      this.openMeteo.fetchMarineData(latitude, longitude, forecastDays, 1),
    ]);

    // Upsert weather observations
    const weatherCount = await this.upsertWeatherData(tenantId, siteId, weatherData, now);

    // Upsert marine observations
    const marineCount = await this.upsertMarineData(tenantId, siteId, marineData, now);

    return { weather: weatherCount, marine: marineCount };
  }

  /**
   * Sync all sites for a tenant
   */
  async syncTenant(tenantId: string, forecastDays: number = 7): Promise<{ totalWeather: number; totalMarine: number; sites: number }> {
    const sites = await this.siteRepo.find({
      where: { tenantId, isActive: true, isDeleted: false },
    });

    const sitesWithCoords = sites.filter((s) => s.location?.latitude && s.location?.longitude);

    let totalWeather = 0;
    let totalMarine = 0;

    for (const site of sitesWithCoords) {
      try {
        const result = await this.syncSite(tenantId, site.id, forecastDays);
        totalWeather += result.weather;
        totalMarine += result.marine;

        // Rate limiting between sites
        if (sitesWithCoords.indexOf(site) < sitesWithCoords.length - 1) {
          await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY));
        }
      } catch (err) {
        this.logger.error(`Failed to sync weather for site ${site.id}: ${err}`);
      }
    }

    // Update last_synced_at
    await this.settingsRepo.upsert(
      { tenantId, lastSyncedAt: new Date() },
      { conflictPaths: ['tenantId'] },
    );

    return { totalWeather, totalMarine, sites: sitesWithCoords.length };
  }

  /**
   * Get or create weather settings for a tenant
   */
  async getSettings(tenantId: string): Promise<WeatherSettings> {
    // FARM-HIGH-060: get-or-create on the fail-closed READ-WRITE tenant boundary.
    // runInTenantTransaction (not runInTenantRead) because the first read for a
    // tenant lazily persists the default row — a read-only transaction would
    // reject that INSERT. The boundary pins search_path + asserts the tenant GUC,
    // so a pooled connection that lost the tenant frame throws instead of
    // silently reading/writing the wrong (empty) schema.
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      let settings = await queryRunner.manager.findOne(WeatherSettings, { where: { tenantId } });
      if (!settings) {
        settings = queryRunner.manager.create(WeatherSettings, { tenantId });
        settings = await queryRunner.manager.save(settings);
      }
      return settings;
    });
  }

  /**
   * Update weather settings
   */
  async updateSettings(
    tenantId: string,
    input: { syncIntervalMinutes?: number; forecastDays?: number; enabled?: boolean },
  ): Promise<WeatherSettings> {
    let settings = await this.getSettings(tenantId);
    if (input.syncIntervalMinutes !== undefined) settings.syncIntervalMinutes = input.syncIntervalMinutes;
    if (input.forecastDays !== undefined) settings.forecastDays = input.forecastDays;
    if (input.enabled !== undefined) settings.enabled = input.enabled;
    return this.settingsRepo.save(settings);
  }

  /**
   * Delete weather data older than given days
   */
  async cleanupOldData(tenantId: string, days: number = 30): Promise<{ weatherDeleted: number; marineDeleted: number }> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const weatherResult = await this.weatherRepo
      .createQueryBuilder()
      .delete()
      .where('observed_at < :cutoff', { cutoff })
      .andWhere('tenant_id = :tenantId', { tenantId })
      .execute();

    const marineResult = await this.marineRepo
      .createQueryBuilder()
      .delete()
      .where('observed_at < :cutoff', { cutoff })
      .andWhere('tenant_id = :tenantId', { tenantId })
      .execute();

    return {
      weatherDeleted: weatherResult.affected || 0,
      marineDeleted: marineResult.affected || 0,
    };
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private async upsertWeatherData(
    tenantId: string,
    siteId: string,
    data: WeatherHourlyData[],
    fetchedAt: Date,
  ): Promise<number> {
    if (data.length === 0) return 0;

    const now = new Date();
    let count = 0;

    // Process in batches of 50 for performance
    const batchSize = 50;
    for (let i = 0; i < data.length; i += batchSize) {
      const batch = data.slice(i, i + batchSize);

      const values = batch.map((row) => ({
        tenantId,
        siteId,
        observedAt: new Date(row.time),
        dataType: new Date(row.time) > now ? WeatherDataType.FORECAST : WeatherDataType.HISTORICAL,
        temperature: row.temperature ?? undefined,
        windSpeed: row.windSpeed ?? undefined,
        windDirection: row.windDirection ?? undefined,
        windGusts: row.windGusts ?? undefined,
        precipitation: row.precipitation ?? undefined,
        cloudCover: row.cloudCover ?? undefined,
        pressureMsl: row.pressureMsl ?? undefined,
        relativeHumidity: row.relativeHumidity ?? undefined,
        fetchedAt,
      }));

      await this.weatherRepo
        .createQueryBuilder()
        .insert()
        .into(WeatherObservation)
        .values(values)
        .orUpdate(
          [
            'temperature',
            'wind_speed',
            'wind_direction',
            'wind_gusts',
            'precipitation',
            'cloud_cover',
            'pressure_msl',
            'relative_humidity',
            'fetched_at',
            'data_type',
            'updated_at',
          ],
          ['tenant_id', 'site_id', 'observed_at', 'data_type'],
        )
        .execute();

      count += batch.length;
    }

    return count;
  }

  private async upsertMarineData(
    tenantId: string,
    siteId: string,
    data: MarineHourlyData[],
    fetchedAt: Date,
  ): Promise<number> {
    if (data.length === 0) return 0;

    const now = new Date();
    let count = 0;

    const batchSize = 50;
    for (let i = 0; i < data.length; i += batchSize) {
      const batch = data.slice(i, i + batchSize);

      const values = batch.map((row) => ({
        tenantId,
        siteId,
        observedAt: new Date(row.time),
        dataType: new Date(row.time) > now ? WeatherDataType.FORECAST : WeatherDataType.HISTORICAL,
        waveHeight: row.waveHeight ?? undefined,
        waveDirection: row.waveDirection ?? undefined,
        wavePeriod: row.wavePeriod ?? undefined,
        swellWaveHeight: row.swellWaveHeight ?? undefined,
        swellWaveDirection: row.swellWaveDirection ?? undefined,
        swellWavePeriod: row.swellWavePeriod ?? undefined,
        oceanCurrentVelocity: row.oceanCurrentVelocity ?? undefined,
        oceanCurrentDirection: row.oceanCurrentDirection ?? undefined,
        seaSurfaceTemperature: row.seaSurfaceTemperature ?? undefined,
        fetchedAt,
      }));

      await this.marineRepo
        .createQueryBuilder()
        .insert()
        .into(MarineObservation)
        .values(values)
        .orUpdate(
          [
            'wave_height',
            'wave_direction',
            'wave_period',
            'swell_wave_height',
            'swell_wave_direction',
            'swell_wave_period',
            'ocean_current_velocity',
            'ocean_current_direction',
            'sea_surface_temperature',
            'fetched_at',
            'data_type',
            'updated_at',
          ],
          ['tenant_id', 'site_id', 'observed_at', 'data_type'],
        )
        .execute();

      count += batch.length;
    }

    return count;
  }
}
