/**
 * Site Weather Section
 * Harita sayfasında site listesinin altına eklenen hava durumu bölümü
 */
import React, { useState, useMemo } from 'react';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ComposedChart,
} from 'recharts';
import {
  useCurrentWeather,
  useWeatherForecast,
  useMarineForecast,
  type WeatherObservation,
  type MarineObservation,
} from '../../hooks/useWeather';
import { WeatherSettingsModal } from './WeatherSettingsModal';

interface Props {
  siteId: string | null;
  siteName?: string;
}

type WeatherTab = 'temperature' | 'wind' | 'precipitation' | 'marine';

// ============================================================================
// Date formatting helper
// ============================================================================

const formatHour = (dateStr: string) => {
  const d = new Date(dateStr);
  return `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:00`;
};

const formatDay = (dateStr: string) => {
  const d = new Date(dateStr);
  const days = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];
  return `${days[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`;
};

// ============================================================================
// Wind direction helper
// ============================================================================

const windDirectionLabel = (deg: number | null): string => {
  if (deg === null) return '-';
  const dirs = ['K', 'KD', 'D', 'GD', 'G', 'GB', 'B', 'KB'];
  return dirs[Math.round(deg / 45) % 8];
};

// ============================================================================
// Current Weather Cards
// ============================================================================

const CurrentWeatherCards: React.FC<{ siteId: string }> = ({ siteId }) => {
  const { data: current, isLoading } = useCurrentWeather(siteId);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-gray-50 rounded-lg p-3 animate-pulse">
            <div className="h-8 bg-gray-200 rounded mb-2" />
            <div className="h-4 bg-gray-200 rounded w-16" />
          </div>
        ))}
      </div>
    );
  }

  if (!current) {
    return (
      <div className="text-sm text-gray-500 bg-gray-50 rounded-lg p-4 text-center">
        Henüz hava verisi yok. Ayarlardan senkronizasyonu başlatın.
      </div>
    );
  }

  const cards = [
    {
      label: 'Sıcaklık',
      value: current.temperature !== null ? `${current.temperature.toFixed(1)}°C` : '-',
      icon: (
        <svg className="w-5 h-5 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707" />
        </svg>
      ),
    },
    {
      label: 'Rüzgar',
      value: current.windSpeed !== null
        ? `${current.windSpeed.toFixed(0)} km/h ${windDirectionLabel(current.windDirection)}`
        : '-',
      icon: (
        <svg className="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
        </svg>
      ),
    },
    {
      label: 'Nem',
      value: current.relativeHumidity !== null ? `%${current.relativeHumidity.toFixed(0)}` : '-',
      icon: (
        <svg className="w-5 h-5 text-cyan-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
        </svg>
      ),
    },
    {
      label: 'Basınç',
      value: current.pressureMsl !== null ? `${current.pressureMsl.toFixed(0)} hPa` : '-',
      icon: (
        <svg className="w-5 h-5 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
      ),
    },
  ];

  // Wind gust warning
  const hasGustWarning = current.windGusts !== null && current.windGusts > 40;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {cards.map((card) => (
          <div key={card.label} className="bg-gray-50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1">
              {card.icon}
              <span className="text-lg font-semibold text-gray-900">{card.value}</span>
            </div>
            <p className="text-xs text-gray-500">{card.label}</p>
          </div>
        ))}
      </div>

      {hasGustWarning && (
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <svg className="w-4 h-4 text-amber-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <span className="text-sm text-amber-800">
            Rüzgar uyarısı: {current.windGusts?.toFixed(0)} km/h hamle bekleniyor
          </span>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Chart Components
// ============================================================================

const TemperatureChart: React.FC<{ weather: WeatherObservation[]; marine: MarineObservation[] }> = ({ weather, marine }) => {
  const data = useMemo(() => {
    // Sample data (every 3 hours for readability)
    const sampled = weather.filter((_, i) => i % 3 === 0);
    return sampled.map((w) => {
      const marineRow = marine.find(
        (m) => new Date(m.observedAt).getTime() === new Date(w.observedAt).getTime(),
      );
      return {
        time: formatHour(w.observedAt),
        temperature: w.temperature !== null ? Number(w.temperature) : null,
        sst: marineRow?.seaSurfaceTemperature !== null ? Number(marineRow?.seaSurfaceTemperature) : null,
      };
    });
  }, [weather, marine]);

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis dataKey="time" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 11 }} unit="°C" />
        <Tooltip />
        <Legend />
        <Line
          type="monotone"
          dataKey="temperature"
          stroke="#f97316"
          strokeWidth={2}
          name="Hava Sıcaklığı (°C)"
          dot={false}
          connectNulls
        />
        <Line
          type="monotone"
          dataKey="sst"
          stroke="#0ea5e9"
          strokeWidth={2}
          strokeDasharray="5 5"
          name="Deniz Sıcaklığı (°C)"
          dot={false}
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  );
};

const WindChart: React.FC<{ weather: WeatherObservation[] }> = ({ weather }) => {
  const data = useMemo(() => {
    const sampled = weather.filter((_, i) => i % 3 === 0);
    return sampled.map((w) => ({
      time: formatHour(w.observedAt),
      windSpeed: w.windSpeed !== null ? Number(w.windSpeed) : null,
      windGusts: w.windGusts !== null ? Number(w.windGusts) : null,
    }));
  }, [weather]);

  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis dataKey="time" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 11 }} unit=" km/h" />
        <Tooltip />
        <Legend />
        <Area
          type="monotone"
          dataKey="windGusts"
          fill="#fecaca"
          stroke="#ef4444"
          strokeWidth={1}
          name="Hamle (km/h)"
          fillOpacity={0.3}
          connectNulls
        />
        <Line
          type="monotone"
          dataKey="windSpeed"
          stroke="#3b82f6"
          strokeWidth={2}
          name="Rüzgar Hızı (km/h)"
          dot={false}
          connectNulls
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
};

const PrecipitationChart: React.FC<{ weather: WeatherObservation[] }> = ({ weather }) => {
  const data = useMemo(() => {
    const sampled = weather.filter((_, i) => i % 3 === 0);
    return sampled.map((w) => ({
      time: formatHour(w.observedAt),
      precipitation: w.precipitation !== null ? Number(w.precipitation) : null,
      humidity: w.relativeHumidity !== null ? Number(w.relativeHumidity) : null,
    }));
  }, [weather]);

  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis dataKey="time" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
        <YAxis yAxisId="left" tick={{ fontSize: 11 }} unit=" mm" />
        <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} unit="%" domain={[0, 100]} />
        <Tooltip />
        <Legend />
        <Bar
          yAxisId="left"
          dataKey="precipitation"
          fill="#60a5fa"
          name="Yağış (mm)"
          radius={[2, 2, 0, 0]}
        />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="humidity"
          stroke="#06b6d4"
          strokeWidth={2}
          name="Nem (%)"
          dot={false}
          connectNulls
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
};

const MarineChart: React.FC<{ marine: MarineObservation[] }> = ({ marine }) => {
  const hasData = marine.length > 0 && marine.some((m) => m.waveHeight !== null);

  const data = useMemo(() => {
    const sampled = marine.filter((_, i) => i % 3 === 0);
    return sampled.map((m) => ({
      time: formatHour(m.observedAt),
      waveHeight: m.waveHeight !== null ? Number(m.waveHeight) : null,
      swellHeight: m.swellWaveHeight !== null ? Number(m.swellWaveHeight) : null,
      currentVelocity: m.oceanCurrentVelocity !== null ? Number(m.oceanCurrentVelocity) : null,
    }));
  }, [marine]);

  if (!hasData) {
    return (
      <div className="flex items-center justify-center h-[280px] bg-gray-50 rounded-lg">
        <div className="text-center">
          <svg className="w-10 h-10 text-gray-300 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
          </svg>
          <p className="text-sm text-gray-500">Bu site için deniz verisi yok</p>
          <p className="text-xs text-gray-400 mt-1">Karadaki siteler için deniz verileri görüntülenemez</p>
        </div>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis dataKey="time" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
        <YAxis yAxisId="left" tick={{ fontSize: 11 }} unit=" m" />
        <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} unit=" m/s" />
        <Tooltip />
        <Legend />
        <Line
          yAxisId="left"
          type="monotone"
          dataKey="waveHeight"
          stroke="#0284c7"
          strokeWidth={2}
          name="Dalga Yüksekliği (m)"
          dot={false}
          connectNulls
        />
        <Area
          yAxisId="left"
          type="monotone"
          dataKey="swellHeight"
          fill="#bae6fd"
          stroke="#38bdf8"
          strokeWidth={1}
          name="Swell Yüksekliği (m)"
          fillOpacity={0.3}
          connectNulls
        />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="currentVelocity"
          stroke="#059669"
          strokeWidth={2}
          strokeDasharray="5 5"
          name="Akıntı Hızı (m/s)"
          dot={false}
          connectNulls
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const SiteWeatherSection: React.FC<Props> = ({ siteId, siteName }) => {
  const [activeTab, setActiveTab] = useState<WeatherTab>('temperature');
  const [showSettings, setShowSettings] = useState(false);

  const { data: weatherData, isLoading: weatherLoading } = useWeatherForecast(siteId, 7);
  const { data: marineData, isLoading: marineLoading } = useMarineForecast(siteId, 7);

  if (!siteId) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="text-center text-sm text-gray-500">
          <svg className="w-8 h-8 text-gray-300 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
          </svg>
          Hava durumu görmek için bir site seçin
        </div>
      </div>
    );
  }

  const tabs: { key: WeatherTab; label: string }[] = [
    { key: 'temperature', label: 'Sıcaklık' },
    { key: 'wind', label: 'Rüzgar' },
    { key: 'precipitation', label: 'Yağış & Nem' },
    { key: 'marine', label: 'Deniz' },
  ];

  const isLoading = weatherLoading || marineLoading;

  return (
    <>
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
            </svg>
            <h3 className="text-base font-semibold text-gray-900">
              Hava Durumu {siteName && <span className="text-gray-500 font-normal">— {siteName}</span>}
            </h3>
          </div>
          <button
            onClick={() => setShowSettings(true)}
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
            title="Ayarlar"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>

        {/* Current weather cards */}
        <CurrentWeatherCards siteId={siteId} />

        {/* Tabs */}
        <div className="flex items-center gap-1 mt-4 mb-3 border-b border-gray-200">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'border-primary-500 text-primary-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Chart */}
        {isLoading ? (
          <div className="flex items-center justify-center h-[280px]">
            <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : !weatherData?.length && !marineData?.length ? (
          <div className="flex items-center justify-center h-[280px] text-sm text-gray-500">
            Henüz veri yok. Ayarlardan senkronizasyonu başlatın.
          </div>
        ) : (
          <>
            {activeTab === 'temperature' && (
              <TemperatureChart weather={weatherData || []} marine={marineData || []} />
            )}
            {activeTab === 'wind' && (
              <WindChart weather={weatherData || []} />
            )}
            {activeTab === 'precipitation' && (
              <PrecipitationChart weather={weatherData || []} />
            )}
            {activeTab === 'marine' && (
              <MarineChart marine={marineData || []} />
            )}
          </>
        )}

        {/* Chart subtitle */}
        <p className="text-xs text-gray-400 mt-2 text-center">
          7 Günlük Tahmin — Open-Meteo (3 saatlik aralıklar)
        </p>
      </div>

      {/* Settings modal */}
      <WeatherSettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />
    </>
  );
};
