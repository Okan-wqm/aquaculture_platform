/**
 * Open-Meteo Client Service
 * Weather ve Marine API'leri ile iletişim
 */
import { Injectable, Logger } from '@nestjs/common';
import { createAbortSignalTimeout } from '@aquaculture/backend-common/utils';

// ============================================================================
// Types
// ============================================================================

export interface WeatherHourlyData {
  time: string;
  temperature: number | null;
  windSpeed: number | null;
  windDirection: number | null;
  windGusts: number | null;
  precipitation: number | null;
  cloudCover: number | null;
  pressureMsl: number | null;
  relativeHumidity: number | null;
}

export interface MarineHourlyData {
  time: string;
  waveHeight: number | null;
  waveDirection: number | null;
  wavePeriod: number | null;
  swellWaveHeight: number | null;
  swellWaveDirection: number | null;
  swellWavePeriod: number | null;
  oceanCurrentVelocity: number | null;
  oceanCurrentDirection: number | null;
  seaSurfaceTemperature: number | null;
}

interface OpenMeteoWeatherResponse {
  hourly: {
    time: string[];
    temperature_2m?: (number | null)[];
    wind_speed_10m?: (number | null)[];
    wind_direction_10m?: (number | null)[];
    wind_gusts_10m?: (number | null)[];
    precipitation?: (number | null)[];
    cloud_cover?: (number | null)[];
    pressure_msl?: (number | null)[];
    relative_humidity_2m?: (number | null)[];
  };
}

interface OpenMeteoMarineResponse {
  hourly: {
    time: string[];
    wave_height?: (number | null)[];
    wave_direction?: (number | null)[];
    wave_period?: (number | null)[];
    swell_wave_height?: (number | null)[];
    swell_wave_direction?: (number | null)[];
    swell_wave_period?: (number | null)[];
    ocean_current_velocity?: (number | null)[];
    ocean_current_direction?: (number | null)[];
    sea_surface_temperature?: (number | null)[];
  };
}

const WEATHER_API_URL = 'https://api.open-meteo.com/v1/forecast';
const MARINE_API_URL = 'https://marine-api.open-meteo.com/v1/marine';

const WEATHER_HOURLY_PARAMS = [
  'temperature_2m',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'precipitation',
  'cloud_cover',
  'pressure_msl',
  'relative_humidity_2m',
].join(',');

const MARINE_HOURLY_PARAMS = [
  'wave_height',
  'wave_direction',
  'wave_period',
  'swell_wave_height',
  'swell_wave_direction',
  'swell_wave_period',
  'ocean_current_velocity',
  'ocean_current_direction',
  'sea_surface_temperature',
].join(',');

const REQUEST_TIMEOUT = 10000; // 10s
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1s base

@Injectable()
export class OpenMeteoService {
  private readonly logger = new Logger(OpenMeteoService.name);

  /**
   * Fetch weather data from Open-Meteo Weather API
   */
  async fetchWeatherData(
    lat: number,
    lng: number,
    forecastDays: number = 7,
    pastDays: number = 1,
  ): Promise<WeatherHourlyData[]> {
    const params = new URLSearchParams({
      latitude: lat.toString(),
      longitude: lng.toString(),
      hourly: WEATHER_HOURLY_PARAMS,
      forecast_days: forecastDays.toString(),
      past_days: pastDays.toString(),
      timezone: 'auto',
      wind_speed_unit: 'kmh',
      temperature_unit: 'celsius',
    });

    const url = `${WEATHER_API_URL}?${params}`;
    const data = await this.fetchWithRetry<OpenMeteoWeatherResponse>(url);

    if (!data?.hourly?.time) {
      this.logger.warn(`No weather data returned for ${lat},${lng}`);
      return [];
    }

    const { hourly } = data;
    return hourly.time.map((time, i) => ({
      time,
      temperature: hourly.temperature_2m?.[i] ?? null,
      windSpeed: hourly.wind_speed_10m?.[i] ?? null,
      windDirection: hourly.wind_direction_10m?.[i] ?? null,
      windGusts: hourly.wind_gusts_10m?.[i] ?? null,
      precipitation: hourly.precipitation?.[i] ?? null,
      cloudCover: hourly.cloud_cover?.[i] ?? null,
      pressureMsl: hourly.pressure_msl?.[i] ?? null,
      relativeHumidity: hourly.relative_humidity_2m?.[i] ?? null,
    }));
  }

  /**
   * Fetch marine data from Open-Meteo Marine API
   */
  async fetchMarineData(
    lat: number,
    lng: number,
    forecastDays: number = 7,
    pastDays: number = 1,
  ): Promise<MarineHourlyData[]> {
    const params = new URLSearchParams({
      latitude: lat.toString(),
      longitude: lng.toString(),
      hourly: MARINE_HOURLY_PARAMS,
      forecast_days: forecastDays.toString(),
      past_days: pastDays.toString(),
      timezone: 'auto',
    });

    const url = `${MARINE_API_URL}?${params}`;

    try {
      const data = await this.fetchWithRetry<OpenMeteoMarineResponse>(url);

      if (!data?.hourly?.time) {
        this.logger.debug(`No marine data returned for ${lat},${lng} (inland site?)`);
        return [];
      }

      const { hourly } = data;
      return hourly.time.map((time, i) => ({
        time,
        waveHeight: hourly.wave_height?.[i] ?? null,
        waveDirection: hourly.wave_direction?.[i] ?? null,
        wavePeriod: hourly.wave_period?.[i] ?? null,
        swellWaveHeight: hourly.swell_wave_height?.[i] ?? null,
        swellWaveDirection: hourly.swell_wave_direction?.[i] ?? null,
        swellWavePeriod: hourly.swell_wave_period?.[i] ?? null,
        oceanCurrentVelocity: hourly.ocean_current_velocity?.[i] ?? null,
        oceanCurrentDirection: hourly.ocean_current_direction?.[i] ?? null,
        seaSurfaceTemperature: hourly.sea_surface_temperature?.[i] ?? null,
      }));
    } catch (err) {
      // Marine API may return errors for inland locations — that's OK
      this.logger.debug(`Marine API error for ${lat},${lng}: ${err}`);
      return [];
    }
  }

  /**
   * Fetch with retry and timeout
   */
  private async fetchWithRetry<T>(url: string, attempt: number = 0): Promise<T> {
    try {
      const timeout = createAbortSignalTimeout(REQUEST_TIMEOUT);

      const response = await fetch(url, { signal: timeout.signal }).finally(() => {
        timeout.clear();
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return (await response.json()) as T;
    } catch (err) {
      if (attempt < MAX_RETRIES - 1) {
        const delay = RETRY_DELAY * Math.pow(2, attempt);
        this.logger.debug(`Retry ${attempt + 1}/${MAX_RETRIES} for ${url} in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        return this.fetchWithRetry<T>(url, attempt + 1);
      }
      throw err;
    }
  }
}
