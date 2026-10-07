/**
 * Readings Page — /sensor/readings
 *
 * Live and historical values of every enabled data channel, per sensor.
 * Values come from channelLatestValues (refreshed every 30 s) and the trend
 * from channelSeries over the selected period (SENSOR-HIGH-138). The page
 * previously rendered Math.random() values per sensor type, which is why a
 * five-channel water-quality sonde showed a single invented temperature.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Calendar,
  Download,
  Filter,
  RefreshCw,
  Server,
  Wifi,
} from 'lucide-react';
import type { TimeRangeSpec } from '@aquaculture/shared-contracts';
import {
  Button,
  PageHeader,
  Select,
  Spinner,
  TimeRangePicker,
  useI18n,
  useTimeRangeLabels,
  useTimeRangeSearchParams,
} from '@aquaculture/shared-ui';

import { downloadCsv } from '../components/readings/downloadCsv';
import { SensorReadingsCard } from '../components/readings/SensorReadingsCard';
import {
  channelFilterOptions,
  DEFAULT_READINGS_PRESET,
  freshness,
  lastReportedAt,
  latestValuesCsv,
  READINGS_PRESETS,
  readingOwners,
} from '../components/readings/readingsModel';
import {
  useChannelDataBounds,
  useChannelLatestValues,
  useSeriesDisplayTimeZone,
} from '../hooks/useChannelReadings';
import { useSensorList } from '../hooks/useSensorList';

const AUTO_REFRESH_MS = 30_000;

/** What the page charts when its link names no range. */
const DEFAULT_RANGE: TimeRangeSpec = { kind: 'relative', preset: DEFAULT_READINGS_PRESET };

/** Ticks once a second so "12 sn önce" and the freshness badge stay current. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const StatCard: React.FC<{
  icon: React.ReactNode;
  tone: string;
  value: number;
  label: string;
}> = ({ icon, tone, value, label }) => (
  <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-4">
    <div className="flex items-center gap-3">
      <div className={`p-2 rounded-lg ${tone}`}>{icon}</div>
      <div>
        <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
        <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
      </div>
    </div>
  </div>
);

const ReadingsPage: React.FC = () => {
  const [selectedChannel, setSelectedChannel] = useState('all');
  // The range lives in the URL, so a link, a reload and Back show the same window.
  const {
    spec: range,
    error: rangeError,
    setSpec: setRange,
  } = useTimeRangeSearchParams(DEFAULT_RANGE);
  const rangeLabels = useTimeRangeLabels();
  const { locale, t } = useI18n();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const now = useNow();

  const {
    sensors,
    loading: sensorsLoading,
    error: sensorsError,
    refetch: refetchSensors,
  } = useSensorList();
  const owners = useMemo(() => readingOwners(sensors), [sensors]);
  const ownerIds = useMemo(() => owners.map((sensor) => sensor.id), [owners]);
  const latest = useChannelLatestValues(ownerIds, autoRefresh ? AUTO_REFRESH_MS : false);
  // One zone for the page, by the server's rule (the sensors' shared site
  // zone, else the tenant's); the picker waits for it rather than guess.
  const displayZone = useSeriesDisplayTimeZone(ownerIds);
  const bounds = useChannelDataBounds(ownerIds);
  const dataBounds = useMemo(() => {
    const firsts: number[] = [];
    const lasts: number[] = [];
    for (const channelBounds of bounds.values()) {
      if (channelBounds.firstSampleAt) firsts.push(new Date(channelBounds.firstSampleAt).getTime());
      if (channelBounds.lastSampleAt) lasts.push(new Date(channelBounds.lastSampleAt).getTime());
    }
    return firsts.length > 0 && lasts.length > 0
      ? { firstMs: Math.min(...firsts), lastMs: Math.max(...lasts) }
      : null;
  }, [bounds]);

  const allChannels = useMemo(() => [...latest.bySensor.values()].flat(), [latest.bySensor]);
  const filterOptions = useMemo(() => channelFilterOptions(allChannels), [allChannels]);

  const visible = useMemo(
    () =>
      owners
        .map((sensor) => {
          const channels = latest.bySensor.get(sensor.id) ?? [];
          return {
            sensor,
            channels:
              selectedChannel === 'all'
                ? channels
                : channels.filter((channel) => channel.channelKey === selectedChannel),
          };
        })
        .filter((entry) => selectedChannel === 'all' || entry.channels.length > 0),
    [owners, latest.bySensor, selectedChannel],
  );

  const stats = useMemo(
    () => ({
      devices: owners.length,
      channels: allChannels.length,
      live: owners.filter(
        (sensor) => freshness(lastReportedAt(latest.bySensor.get(sensor.id) ?? []), now) === 'live',
      ).length,
      warning: allChannels.filter((channel) => channel.alertLevel === 'WARNING').length,
      critical: allChannels.filter((channel) => channel.alertLevel === 'CRITICAL').length,
    }),
    [owners, allChannels, latest.bySensor, now],
  );

  const loading = sensorsLoading || (ownerIds.length > 0 && latest.loading);
  const error = sensorsError ?? latest.error;
  const refresh = (): void => {
    void refetchSensors();
    latest.refetch();
  };

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Canlı Okumalar"
        description={
          loading ? 'Yükleniyor...' : `${stats.devices} cihaz, ${stats.channels} veri kanalı`
        }
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={refresh}
              disabled={loading}
              leftIcon={<RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />}
            >
              Yenile
            </Button>
            <Button
              variant={autoRefresh ? 'primary' : 'secondary'}
              onClick={() => setAutoRefresh((on) => !on)}
              aria-pressed={autoRefresh}
            >
              {autoRefresh ? 'Otomatik (30s)' : 'Manuel'}
            </Button>
            <Button
              variant="primary"
              leftIcon={<Download className="w-4 h-4" />}
              disabled={allChannels.length === 0}
              onClick={() =>
                downloadCsv(latestValuesCsv(owners, latest.bySensor, locale), 'sensor-okumalari')
              }
            >
              Dışa Aktar
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <StatCard
          icon={<Server className="w-5 h-5 text-info-600 dark:text-info-400" />}
          tone="bg-info-50 dark:bg-info-900/20"
          value={stats.devices}
          label="Cihaz"
        />
        <StatCard
          icon={<Activity className="w-5 h-5 text-info-600 dark:text-info-400" />}
          tone="bg-info-50 dark:bg-info-900/20"
          value={stats.channels}
          label="Veri Kanalı"
        />
        <StatCard
          icon={<Wifi className="w-5 h-5 text-success-600 dark:text-success-400" />}
          tone="bg-success-50 dark:bg-success-900/20"
          value={stats.live}
          label="Veri Akan Cihaz"
        />
        <StatCard
          icon={<AlertCircle className="w-5 h-5 text-warning-600 dark:text-warning-400" />}
          tone="bg-warning-50 dark:bg-warning-900/20"
          value={stats.warning}
          label="Uyarı"
        />
        <StatCard
          icon={<AlertCircle className="w-5 h-5 text-error-600 dark:text-error-400" />}
          tone="bg-error-50 dark:bg-error-900/20"
          value={stats.critical}
          label="Kritik"
        />
      </div>

      {error && (
        <div
          role="alert"
          className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg p-4 flex items-center gap-3"
        >
          <AlertCircle className="w-5 h-5 text-error-500" />
          <div>
            <p className="text-error-800 dark:text-error-200 font-medium">Okumalar yüklenemedi</p>
            <p className="text-error-600 dark:text-error-400 text-sm">{error}</p>
          </div>
          <Button variant="secondary" size="sm" className="ml-auto" onClick={refresh}>
            Tekrar Dene
          </Button>
        </div>
      )}

      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-4">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5 text-gray-500 dark:text-gray-400" />
            <Select
              aria-label="Parametre"
              options={[{ value: 'all', label: 'Tüm Parametreler' }, ...filterOptions]}
              value={selectedChannel}
              onChange={(event) => setSelectedChannel(event.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <Calendar className="w-5 h-5 text-gray-500 dark:text-gray-400" />
            {displayZone.zone ? (
              <TimeRangePicker
                value={range}
                onChange={setRange}
                presets={READINGS_PRESETS}
                timeZone={displayZone.zone.displayTimeZone}
                dataBounds={dataBounds}
              />
            ) : displayZone.error !== null ? (
              <span role="alert" className="text-sm text-error-600 dark:text-error-400">
                {t('series.zoneLoadFailed', { error: displayZone.error })}
              </span>
            ) : (
              // The picker reads days in the site's zone; until the server
              // names it there is nothing honest to pick in.
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {ownerIds.length > 0 ? t('series.loading') : rangeLabels.label}
              </span>
            )}
          </div>
        </div>
      </div>

      {rangeError !== null && (
        <div
          role="alert"
          className="bg-warning-50 dark:bg-warning-900/20 border border-warning-200 dark:border-warning-800 rounded-lg p-3 text-sm text-warning-800 dark:text-warning-200"
        >
          {t('series.rangeInvalid', { reason: rangeLabels.error(rangeError) })}
        </div>
      )}

      {loading && visible.length === 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-12 flex flex-col items-center justify-center text-gray-500 dark:text-gray-400">
          <Spinner size="lg" color="inherit" className="mb-3" />
          <p>Okumalar yükleniyor...</p>
        </div>
      )}

      {!loading && visible.length === 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-12 flex flex-col items-center justify-center text-gray-500 dark:text-gray-400">
          <Activity className="w-12 h-12 mb-3 opacity-50" />
          <p className="text-lg font-medium">
            {selectedChannel === 'all'
              ? 'Henüz cihaz kaydedilmemiş'
              : 'Bu parametreyi ölçen cihaz yok'}
          </p>
          <p className="text-sm mt-1">
            {selectedChannel === 'all'
              ? 'Yeni cihaz eklemek için Cihazlar sayfasını kullanın'
              : 'Farklı bir parametre seçin'}
          </p>
        </div>
      )}

      {visible.length > 0 && (
        <div className="space-y-4">
          {visible.map(({ sensor, channels }) => (
            <SensorReadingsCard
              key={sensor.id}
              sensor={sensor}
              channels={channels}
              range={range}
              bounds={bounds}
              onShowRange={setRange}
              now={now}
              defaultExpanded={visible.length <= 3}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default ReadingsPage;
