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
import { Button, PageHeader, Select, Spinner } from '@aquaculture/shared-ui';

import { SensorReadingsCard } from '../components/readings/SensorReadingsCard';
import {
  PERIODS,
  channelFilterOptions,
  freshness,
  lastReportedAt,
  latestValuesCsv,
  periodMs,
  readingOwners,
  type PeriodValue,
} from '../components/readings/readingsModel';
import { useChannelLatestValues } from '../hooks/useChannelReadings';
import { useSensorList } from '../hooks/useSensorList';

const AUTO_REFRESH_MS = 30_000;

/** Ticks once a second so "12 sn önce" and the freshness badge stay current. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function downloadCsv(content: string): void {
  // Leading BOM so Excel opens the UTF-8 file with Turkish characters intact.
  const blob = new Blob(['﻿', content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `sensor-okumalari-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.csv`;
  link.click();
  URL.revokeObjectURL(url);
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
  const [period, setPeriod] = useState<PeriodValue>('24h');
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
              onClick={() => downloadCsv(latestValuesCsv(owners, latest.bySensor))}
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
            <Select
              aria-label="Trend dönemi"
              options={PERIODS.map(({ value, label }) => ({ value, label }))}
              value={period}
              onChange={(event) => setPeriod(event.target.value as PeriodValue)}
            />
          </div>
        </div>
      </div>

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
              rangeMs={periodMs(period)}
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
