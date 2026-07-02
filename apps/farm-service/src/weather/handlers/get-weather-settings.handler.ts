/**
 * Get Weather Settings Query Handler — fail-closed tenant boundary
 * (FARM-HIGH-060).
 *
 * Thin CQRS wrapper that delegates to WeatherSyncService.getSettings, which is
 * the single fail-closed SSoT (get-or-create on runInTenantTransaction). The
 * internal callers (sync cron, updateSettings mutation) use the same method, so
 * there is one boundary-enforced implementation, not a duplicated one.
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';

import { WeatherSettings } from '../entities/weather-settings.entity';
import { WeatherSyncService } from '../services/weather-sync.service';
import { GetWeatherSettingsQuery } from '../queries/get-weather-settings.query';

@QueryHandler(GetWeatherSettingsQuery)
export class GetWeatherSettingsHandler implements IQueryHandler<GetWeatherSettingsQuery> {
  constructor(private readonly weatherSyncService: WeatherSyncService) {}

  async execute(query: GetWeatherSettingsQuery): Promise<WeatherSettings> {
    return this.weatherSyncService.getSettings(query.tenantId);
  }
}
