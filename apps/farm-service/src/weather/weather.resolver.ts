/**
 * Weather GraphQL Resolver
 */
import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, MoreThanOrEqual, Between } from 'typeorm';
import { CurrentTenant, Roles, Role } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { WeatherObservation, WeatherDataType } from './entities/weather-observation.entity';
import { MarineObservation } from './entities/marine-observation.entity';
import { WeatherSettings } from './entities/weather-settings.entity';
import { WeatherFilterInput } from './dto/weather-filter.input';
import { UpdateWeatherSettingsInput } from './dto/weather-settings.input';
import { CurrentWeatherResponse, WeatherSyncResult } from './dto/current-weather.response';
import { WeatherSyncService } from './services/weather-sync.service';
import { QueryBus } from '@platform/cqrs';
import { GetWeatherSettingsQuery } from './queries/get-weather-settings.query';

/**
 * Coerce a decimal-column value to a number for the GraphQL response, preserving a
 * genuine 0 (calm sea, 0 °C, North = 0°, 0 mm precip, 0 % cloud) and mapping only
 * null/undefined to undefined. The previous truthy guard silently dropped exact-zero
 * measurements from the current-conditions payload.
 */
function toOptionalNumber(value: number | string | null | undefined): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

@Resolver()
@UseGuards(TenantGuard)
export class WeatherResolver {
  private readonly logger = new Logger(WeatherResolver.name);

  constructor(
    @InjectRepository(WeatherObservation)
    private readonly weatherRepo: Repository<WeatherObservation>,
    @InjectRepository(MarineObservation)
    private readonly marineRepo: Repository<MarineObservation>,
    private readonly syncService: WeatherSyncService,
    private readonly queryBus: QueryBus,
  ) {}

  // =========================================================================
  // Queries
  // =========================================================================

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [WeatherObservation])
  async weatherObservations(
    @Args('siteId', { type: () => ID }) siteId: string,
    @Args('filter', { type: () => WeatherFilterInput, nullable: true }) filter: WeatherFilterInput | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<WeatherObservation[]> {
    const where: Record<string, unknown> = { tenantId, siteId };

    if (filter?.dataType) where.dataType = filter.dataType;
    if (filter?.from && filter?.to) {
      where.observedAt = Between(filter.from, filter.to);
    } else if (filter?.from) {
      where.observedAt = MoreThanOrEqual(filter.from);
    } else if (filter?.to) {
      where.observedAt = LessThanOrEqual(filter.to);
    }

    return this.weatherRepo.find({
      where,
      order: { observedAt: 'ASC' },
      take: 1000, // Safety limit
    });
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [MarineObservation])
  async marineObservations(
    @Args('siteId', { type: () => ID }) siteId: string,
    @Args('filter', { type: () => WeatherFilterInput, nullable: true }) filter: WeatherFilterInput | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<MarineObservation[]> {
    const where: Record<string, unknown> = { tenantId, siteId };

    if (filter?.dataType) where.dataType = filter.dataType;
    if (filter?.from && filter?.to) {
      where.observedAt = Between(filter.from, filter.to);
    } else if (filter?.from) {
      where.observedAt = MoreThanOrEqual(filter.from);
    } else if (filter?.to) {
      where.observedAt = LessThanOrEqual(filter.to);
    }

    return this.marineRepo.find({
      where,
      order: { observedAt: 'ASC' },
      take: 1000,
    });
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => CurrentWeatherResponse, { nullable: true })
  async currentWeather(
    @Args('siteId', { type: () => ID }) siteId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<CurrentWeatherResponse | null> {
    const now = new Date();

    // Get closest weather observation to now
    const weather = await this.weatherRepo.findOne({
      where: { tenantId, siteId, observedAt: LessThanOrEqual(now) },
      order: { observedAt: 'DESC' },
    });

    if (!weather) return null;

    // Get closest marine observation
    const marine = await this.marineRepo.findOne({
      where: { tenantId, siteId, observedAt: LessThanOrEqual(now) },
      order: { observedAt: 'DESC' },
    });

    return {
      siteId,
      observedAt: weather.observedAt,
      temperature: toOptionalNumber(weather.temperature),
      windSpeed: toOptionalNumber(weather.windSpeed),
      windDirection: toOptionalNumber(weather.windDirection),
      windGusts: toOptionalNumber(weather.windGusts),
      precipitation: toOptionalNumber(weather.precipitation),
      cloudCover: toOptionalNumber(weather.cloudCover),
      pressureMsl: toOptionalNumber(weather.pressureMsl),
      relativeHumidity: toOptionalNumber(weather.relativeHumidity),
      waveHeight: toOptionalNumber(marine?.waveHeight),
      waveDirection: toOptionalNumber(marine?.waveDirection),
      wavePeriod: toOptionalNumber(marine?.wavePeriod),
      swellWaveHeight: toOptionalNumber(marine?.swellWaveHeight),
      seaSurfaceTemperature: toOptionalNumber(marine?.seaSurfaceTemperature),
      fetchedAt: weather.fetchedAt,
    };
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [WeatherObservation])
  async weatherForecast(
    @Args('siteId', { type: () => ID }) siteId: string,
    @Args('days', { type: () => Number, nullable: true, defaultValue: 7 }) days: number,
    @CurrentTenant() tenantId: string,
  ): Promise<WeatherObservation[]> {
    const now = new Date();
    const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    return this.weatherRepo.find({
      where: {
        tenantId,
        siteId,
        dataType: WeatherDataType.FORECAST,
        observedAt: Between(now, end),
      },
      order: { observedAt: 'ASC' },
    });
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Query(() => WeatherSettings)
  async weatherSettings(
    @CurrentTenant() tenantId: string,
  ): Promise<WeatherSettings> {
    return this.queryBus.execute(new GetWeatherSettingsQuery(tenantId));
  }

  // =========================================================================
  // Mutations
  // =========================================================================

  @Mutation(() => WeatherSyncResult)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async syncWeatherData(
    @Args('siteId', { type: () => ID, nullable: true }) siteId: string | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<WeatherSyncResult> {
    this.logger.log(`Manual weather sync for tenant ${tenantId}, site: ${siteId || 'all'}`);

    const settings = await this.syncService.getSettings(tenantId);

    if (siteId) {
      const result = await this.syncService.syncSite(tenantId, siteId, settings.forecastDays);
      return {
        success: true,
        totalWeather: result.weather,
        totalMarine: result.marine,
        sites: 1,
      };
    }

    const result = await this.syncService.syncTenant(tenantId, settings.forecastDays);
    return {
      success: true,
      totalWeather: result.totalWeather,
      totalMarine: result.totalMarine,
      sites: result.sites,
    };
  }

  @Mutation(() => WeatherSettings)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateWeatherSettings(
    @Args('input') input: UpdateWeatherSettingsInput,
    @CurrentTenant() tenantId: string,
  ): Promise<WeatherSettings> {
    this.logger.log(`Updating weather settings for tenant ${tenantId}`);
    return this.syncService.updateSettings(tenantId, input);
  }
}
