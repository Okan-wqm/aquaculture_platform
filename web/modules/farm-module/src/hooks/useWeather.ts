/**
 * Weather Hooks
 * Open-Meteo hava durumu ve deniz verisi için React Query hook'ları
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { graphqlClient } from '@aquaculture/shared-ui';

// ============================================================================
// Types
// ============================================================================

export interface WeatherObservation {
  id: string;
  siteId: string;
  observedAt: string;
  dataType: 'forecast' | 'historical';
  temperature: number | null;
  windSpeed: number | null;
  windDirection: number | null;
  windGusts: number | null;
  precipitation: number | null;
  cloudCover: number | null;
  pressureMsl: number | null;
  relativeHumidity: number | null;
  fetchedAt: string;
}

export interface MarineObservation {
  id: string;
  siteId: string;
  observedAt: string;
  dataType: 'forecast' | 'historical';
  waveHeight: number | null;
  waveDirection: number | null;
  wavePeriod: number | null;
  swellWaveHeight: number | null;
  swellWaveDirection: number | null;
  swellWavePeriod: number | null;
  oceanCurrentVelocity: number | null;
  oceanCurrentDirection: number | null;
  seaSurfaceTemperature: number | null;
  fetchedAt: string;
}

export interface CurrentWeather {
  siteId: string;
  observedAt: string;
  temperature: number | null;
  windSpeed: number | null;
  windDirection: number | null;
  windGusts: number | null;
  precipitation: number | null;
  cloudCover: number | null;
  pressureMsl: number | null;
  relativeHumidity: number | null;
  waveHeight: number | null;
  waveDirection: number | null;
  wavePeriod: number | null;
  swellWaveHeight: number | null;
  seaSurfaceTemperature: number | null;
  fetchedAt: string | null;
}

export interface WeatherSettings {
  id: string;
  tenantId: string;
  syncIntervalMinutes: number;
  forecastDays: number;
  enabled: boolean;
  lastSyncedAt: string | null;
}

export interface WeatherSyncResult {
  success: boolean;
  totalWeather: number;
  totalMarine: number;
  sites: number;
}

// ============================================================================
// GraphQL Queries
// ============================================================================

const WEATHER_FORECAST_QUERY = `
  query WeatherForecast($siteId: ID!, $days: Float) {
    weatherForecast(siteId: $siteId, days: $days) {
      id
      siteId
      observedAt
      dataType
      temperature
      windSpeed
      windDirection
      windGusts
      precipitation
      cloudCover
      pressureMsl
      relativeHumidity
      fetchedAt
    }
  }
`;

const MARINE_OBSERVATIONS_QUERY = `
  query MarineObservations($siteId: ID!, $filter: WeatherFilterInput) {
    marineObservations(siteId: $siteId, filter: $filter) {
      id
      siteId
      observedAt
      dataType
      waveHeight
      waveDirection
      wavePeriod
      swellWaveHeight
      swellWaveDirection
      swellWavePeriod
      oceanCurrentVelocity
      oceanCurrentDirection
      seaSurfaceTemperature
      fetchedAt
    }
  }
`;

const CURRENT_WEATHER_QUERY = `
  query CurrentWeather($siteId: ID!) {
    currentWeather(siteId: $siteId) {
      siteId
      observedAt
      temperature
      windSpeed
      windDirection
      windGusts
      precipitation
      cloudCover
      pressureMsl
      relativeHumidity
      waveHeight
      waveDirection
      wavePeriod
      swellWaveHeight
      seaSurfaceTemperature
      fetchedAt
    }
  }
`;

const WEATHER_SETTINGS_QUERY = `
  query WeatherSettings {
    weatherSettings {
      id
      tenantId
      syncIntervalMinutes
      forecastDays
      enabled
      lastSyncedAt
    }
  }
`;

const SYNC_WEATHER_MUTATION = `
  mutation SyncWeatherData($siteId: ID) {
    syncWeatherData(siteId: $siteId) {
      success
      totalWeather
      totalMarine
      sites
    }
  }
`;

const UPDATE_WEATHER_SETTINGS_MUTATION = `
  mutation UpdateWeatherSettings($input: UpdateWeatherSettingsInput!) {
    updateWeatherSettings(input: $input) {
      id
      tenantId
      syncIntervalMinutes
      forecastDays
      enabled
      lastSyncedAt
    }
  }
`;

// ============================================================================
// Hooks
// ============================================================================

/**
 * Fetch weather forecast data for a site
 */
export function useWeatherForecast(siteId: string | null, days: number = 7) {
  return useQuery({
    queryKey: ['weather', 'forecast', siteId, days],
    queryFn: async () => {
      const data = await graphqlClient.request<{ weatherForecast: WeatherObservation[] }>(
        WEATHER_FORECAST_QUERY,
        { siteId, days },
      );
      return data.weatherForecast;
    },
    enabled: !!siteId,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Fetch marine forecast data for a site
 */
export function useMarineForecast(siteId: string | null, days: number = 7) {
  const now = new Date();
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  return useQuery({
    queryKey: ['marine', 'forecast', siteId, days],
    queryFn: async () => {
      const data = await graphqlClient.request<{ marineObservations: MarineObservation[] }>(
        MARINE_OBSERVATIONS_QUERY,
        {
          siteId,
          filter: { from: now.toISOString(), to: end.toISOString() },
        },
      );
      return data.marineObservations;
    },
    enabled: !!siteId,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Fetch current weather (closest observation to now)
 */
export function useCurrentWeather(siteId: string | null) {
  return useQuery({
    queryKey: ['weather', 'current', siteId],
    queryFn: async () => {
      const data = await graphqlClient.request<{ currentWeather: CurrentWeather | null }>(
        CURRENT_WEATHER_QUERY,
        { siteId },
      );
      return data.currentWeather;
    },
    enabled: !!siteId,
    staleTime: 10 * 60 * 1000, // 10 minutes
  });
}

/**
 * Fetch weather settings for the current tenant
 */
export function useWeatherSettings() {
  return useQuery({
    queryKey: ['weatherSettings'],
    queryFn: async () => {
      const data = await graphqlClient.request<{ weatherSettings: WeatherSettings }>(
        WEATHER_SETTINGS_QUERY,
      );
      return data.weatherSettings;
    },
    staleTime: 60 * 1000, // 1 minute
  });
}

/**
 * Manual sync weather data mutation
 */
export function useSyncWeather() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (siteId?: string) => {
      const data = await graphqlClient.request<{ syncWeatherData: WeatherSyncResult }>(
        SYNC_WEATHER_MUTATION,
        { siteId: siteId || null },
      );
      return data.syncWeatherData;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['weather'] });
      queryClient.invalidateQueries({ queryKey: ['marine'] });
      queryClient.invalidateQueries({ queryKey: ['weatherSettings'] });
    },
  });
}

/**
 * Update weather settings mutation
 */
export function useUpdateWeatherSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      syncIntervalMinutes?: number;
      forecastDays?: number;
      enabled?: boolean;
    }) => {
      const data = await graphqlClient.request<{ updateWeatherSettings: WeatherSettings }>(
        UPDATE_WEATHER_SETTINGS_MUTATION,
        { input },
      );
      return data.updateWeatherSettings;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['weatherSettings'] });
    },
  });
}
