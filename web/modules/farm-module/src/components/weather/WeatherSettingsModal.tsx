/**
 * Weather Settings Modal
 * Tenant bazlı hava durumu sync ayarları
 */
import React, { useState, useEffect } from 'react';
import { useWeatherSettings, useUpdateWeatherSettings, useSyncWeather } from '../../hooks/useWeather';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const INTERVAL_OPTIONS = [
  { value: 15, label: '15 dakika' },
  { value: 30, label: '30 dakika' },
  { value: 60, label: '1 saat' },
  { value: 180, label: '3 saat' },
  { value: 360, label: '6 saat' },
];

const FORECAST_DAY_OPTIONS = [
  { value: 3, label: '3 gün' },
  { value: 5, label: '5 gün' },
  { value: 7, label: '7 gün' },
  { value: 14, label: '14 gün' },
];

export const WeatherSettingsModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const { data: settings, isLoading } = useWeatherSettings();
  const updateSettings = useUpdateWeatherSettings();
  const syncWeather = useSyncWeather();

  const [syncInterval, setSyncInterval] = useState(60);
  const [forecastDays, setForecastDays] = useState(7);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (settings) {
      setSyncInterval(settings.syncIntervalMinutes);
      setForecastDays(settings.forecastDays);
      setEnabled(settings.enabled);
    }
  }, [settings]);

  if (!isOpen) return null;

  const handleSave = async () => {
    await updateSettings.mutateAsync({
      syncIntervalMinutes: syncInterval,
      forecastDays,
      enabled,
    });
    onClose();
  };

  const handleManualSync = () => {
    syncWeather.mutate(undefined);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Overlay */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-semibold text-gray-900">Hava Durumu Ayarları</h3>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 rounded"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <div className="space-y-5">
            {/* Auto sync toggle */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-gray-700">Otomatik Senkronizasyon</label>
                <p className="text-xs text-gray-500">Hava verilerini periyodik güncelle</p>
              </div>
              <button
                type="button"
                onClick={() => setEnabled(!enabled)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  enabled ? 'bg-primary-600' : 'bg-gray-200'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    enabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            {/* Sync interval */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Güncelleme Sıklığı
              </label>
              <select
                value={syncInterval}
                onChange={(e) => setSyncInterval(Number(e.target.value))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-primary-500"
                disabled={!enabled}
              >
                {INTERVAL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* Forecast days */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Tahmin Süresi
              </label>
              <select
                value={forecastDays}
                onChange={(e) => setForecastDays(Number(e.target.value))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-primary-500"
              >
                {FORECAST_DAY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* Last synced */}
            {settings?.lastSyncedAt && (
              <div className="text-xs text-gray-500">
                Son güncelleme: {new Date(settings.lastSyncedAt).toLocaleString('tr-TR')}
              </div>
            )}

            {/* Manual sync */}
            <button
              type="button"
              onClick={handleManualSync}
              disabled={syncWeather.isPending}
              className="w-full px-4 py-2 text-sm font-medium text-primary-700 bg-primary-50 border border-primary-200 rounded-lg hover:bg-primary-100 disabled:opacity-50"
            >
              {syncWeather.isPending ? 'Güncelleniyor...' : 'Şimdi Güncelle'}
            </button>

            {syncWeather.data && (
              <div className="text-xs text-green-600 bg-green-50 rounded-lg px-3 py-2">
                {syncWeather.data.sites} site güncellendi:
                {' '}{syncWeather.data.totalWeather} hava, {syncWeather.data.totalMarine} deniz verisi
              </div>
            )}

            {/* Action buttons */}
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
              >
                İptal
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={updateSettings.isPending}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50"
              >
                {updateSettings.isPending ? 'Kaydediliyor...' : 'Kaydet'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
