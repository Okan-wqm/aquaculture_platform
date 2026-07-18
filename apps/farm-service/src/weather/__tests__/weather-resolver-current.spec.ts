import { createMockRepository } from '@aquaculture/testing';
import type { QueryBus } from '@platform/cqrs';

import { MarineObservation } from '../entities/marine-observation.entity';
import { WeatherObservation } from '../entities/weather-observation.entity';
import type { WeatherSyncService } from '../services/weather-sync.service';
import { WeatherResolver } from '../weather.resolver';

/**
 * F-WX-01: currentWeather must preserve genuine 0 measurements (calm sea, 0 °C,
 * North = 0°, 0 mm precip, 0 % cloud). The previous truthy guard mapped them to
 * undefined, silently dropping real physical states from the payload.
 */
describe('WeatherResolver.currentWeather', () => {
  it('preserves exact-zero measurements instead of dropping them', async () => {
    const observedAt = new Date('2026-01-01T00:00:00.000Z');
    const fetchedAt = new Date('2026-01-01T00:05:00.000Z');

    const weatherRepo = createMockRepository<WeatherObservation>();
    weatherRepo.findOne.mockResolvedValue({
      observedAt,
      temperature: 0,
      windSpeed: 0,
      windDirection: 0,
      windGusts: 0,
      precipitation: 0,
      cloudCover: 0,
      pressureMsl: 0,
      relativeHumidity: 0,
      fetchedAt,
    } as WeatherObservation);

    const marineRepo = createMockRepository<MarineObservation>();
    marineRepo.findOne.mockResolvedValue({
      waveHeight: 0,
      waveDirection: 0,
      wavePeriod: 0,
      swellWaveHeight: 0,
      seaSurfaceTemperature: 0,
    } as MarineObservation);

    const resolver = new WeatherResolver(
      weatherRepo,
      marineRepo,
      {} as WeatherSyncService,
      {} as QueryBus,
    );

    const result = await resolver.currentWeather('site-1', 'tenant-1');

    expect(result).not.toBeNull();
    expect(result?.temperature).toBe(0);
    expect(result?.windDirection).toBe(0);
    expect(result?.cloudCover).toBe(0);
    expect(result?.precipitation).toBe(0);
    expect(result?.waveHeight).toBe(0);
    expect(result?.seaSurfaceTemperature).toBe(0);
  });
});
