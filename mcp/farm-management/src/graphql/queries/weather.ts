// ============================================================================
// MCP Farm Intelligence — Weather (Hava Durumu) Sorguları
// ============================================================================
//
// Hava durumu gözlemleri ve tahminlerini sorgulayan GraphQL query'leri.
//
// NEDEN GEREKLİ:
//   - Hava koşulları su sıcaklığını doğrudan etkiler (balık poikilotermdir)
//   - Fırtına ve yüksek dalga balık kafeslerini riske sokar
//   - Sıcaklık değişimleri yemleme oranını ve büyüme hızını etkiler
//   - Cross-domain korelasyonda hava durumu ↔ su kalitesi ↔ büyüme ilişkisi kurulur
//   - Deniz koşulları (dalga yüksekliği, akıntı) deniz kafesi operasyonları için kritiktir
//
// GraphQL Endpoint: currentWeather, weatherObservations, weatherForecast
// ============================================================================

import type { GraphQLClient } from '../client.js';

// ── Tip Tanımları ──────────────────────────────────────────────────

/**
 * Anlık hava durumu yanıtı.
 * Atmosfer ve deniz koşullarını birleştirir.
 */
export interface CurrentWeather {
  siteId: string;
  observedAt: string;
  /** Hava sıcaklığı (°C) */
  temperature?: number;
  /** Rüzgar hızı (m/s) */
  windSpeed?: number;
  /** Rüzgar yönü (derece, 0-360) */
  windDirection?: number;
  /** Rüzgar hamleleri / maksimum rüzgar (m/s) */
  windGusts?: number;
  /** Yağış miktarı (mm) */
  precipitation?: number;
  /** Bulut örtüsü (%) */
  cloudCover?: number;
  /** Deniz seviyesi basıncı (hPa) */
  pressureMsl?: number;
  /** Bağıl nem (%) */
  relativeHumidity?: number;
  /** Dalga yüksekliği (m) — deniz tesisleri için */
  waveHeight?: number;
  /** Dalga yönü (derece) */
  waveDirection?: number;
  /** Dalga periyodu (saniye) */
  wavePeriod?: number;
  /** Kabarma dalga yüksekliği (m) */
  swellWaveHeight?: number;
  /** Deniz yüzeyi sıcaklığı (°C) */
  seaSurfaceTemperature?: number;
  fetchedAt?: string;
}

/**
 * Hava gözlemi kaydı.
 * WeatherObservation entity'sine karşılık gelir.
 * Saatlik veya günlük gözlem/tahmin verileri.
 */
export interface WeatherObservation {
  id: string;
  siteId: string;
  dataType: string;
  observedAt: string;
  temperature?: number;
  windSpeed?: number;
  windDirection?: number;
  windGusts?: number;
  precipitation?: number;
  cloudCover?: number;
  pressureMsl?: number;
  relativeHumidity?: number;
  fetchedAt?: string;
}

// ── Sorgular ────────────────────────────────────────────────────────

/**
 * Site için anlık hava durumunu getirir.
 *
 * Kullanım: Dashboard gösterimi, operasyonel karar desteği.
 * En son kayıtlı gözlem ve deniz verisi birleştirilerek döner.
 * Null dönebilir — henüz hava verisi alınmamış site'lar için.
 *
 * @param siteId - Site UUID'si
 */
export async function fetchCurrentWeather(
  client: GraphQLClient,
  siteId: string,
): Promise<CurrentWeather | null> {
  const query = `
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

  const data = await client.query<{ currentWeather: CurrentWeather | null }>(query, { siteId });
  return data.currentWeather;
}

/**
 * Site için hava gözlemlerini getirir.
 *
 * Kullanım: Hava geçmişi analizi, su sıcaklığı korelasyonu.
 * Tarih filtreleri ile belirli bir dönem seçilebilir.
 * Maksimum 1000 kayıt döner (gateway güvenlik limiti).
 *
 * @param siteId - Site UUID'si
 * @param from - Başlangıç tarihi (ISO string, opsiyonel)
 * @param to - Bitiş tarihi (ISO string, opsiyonel)
 */
export async function fetchWeatherObservations(
  client: GraphQLClient,
  siteId: string,
  from?: string,
  to?: string,
): Promise<WeatherObservation[]> {
  const query = `
    query WeatherObservations($siteId: ID!, $filter: WeatherFilterInput) {
      weatherObservations(siteId: $siteId, filter: $filter) {
        id
        siteId
        dataType
        observedAt
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

  const data = await client.query<{ weatherObservations: WeatherObservation[] }>(query, {
    siteId,
    filter: from || to
      ? {
          from: from ?? null,
          to: to ?? null,
        }
      : null,
  });
  return data.weatherObservations;
}

/**
 * Site için hava tahminini getirir.
 *
 * Kullanım: Gelecek günler için operasyonel planlama.
 * Fırtına tahmini varsa kafes operasyonları ertelenir,
 * sıcaklık değişimi varsa yemleme planı ayarlanır.
 *
 * @param siteId - Site UUID'si
 * @param days - Kaç günlük tahmin (varsayılan: 7)
 */
export async function fetchWeatherForecast(
  client: GraphQLClient,
  siteId: string,
  days = 7,
): Promise<WeatherObservation[]> {
  const query = `
    query WeatherForecast($siteId: ID!, $days: Float) {
      weatherForecast(siteId: $siteId, days: $days) {
        id
        siteId
        dataType
        observedAt
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

  const data = await client.query<{ weatherForecast: WeatherObservation[] }>(query, {
    siteId,
    days,
  });
  return data.weatherForecast;
}
