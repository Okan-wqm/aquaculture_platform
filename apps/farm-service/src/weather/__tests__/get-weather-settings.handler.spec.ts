/**
 * GetWeatherSettingsHandler — delegates to the fail-closed WeatherSyncService
 * SSoT (FARM-HIGH-060). The boundary/get-or-create logic lives in the service;
 * this proves the CQRS read dispatches to it unchanged.
 */
import { GetWeatherSettingsHandler } from '../handlers/get-weather-settings.handler';
import { GetWeatherSettingsQuery } from '../queries/get-weather-settings.query';
import { WeatherSyncService } from '../services/weather-sync.service';
import { WeatherSettings } from '../entities/weather-settings.entity';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('GetWeatherSettingsHandler', () => {
  it('delegates the tenant-scoped read to WeatherSyncService.getSettings', async () => {
    const settings: WeatherSettings = {
      id: 's-1',
      tenantId,
      syncIntervalMinutes: 60,
      forecastDays: 7,
      enabled: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const getSettings = jest.fn().mockResolvedValue(settings);
    const service: Pick<WeatherSyncService, 'getSettings'> = { getSettings };

    const result = await new GetWeatherSettingsHandler(service as WeatherSyncService).execute(
      new GetWeatherSettingsQuery(tenantId),
    );

    expect(result).toBe(settings);
    expect(getSettings).toHaveBeenCalledWith(tenantId);
  });
});
