/**
 * VfdControlPanel — live telemetry and start/stop/emergency-stop for one drive.
 *
 * SENSOR-HIGH-066: this used to live inside DeviceDetailPage (the SENSOR detail
 * page) behind `device.type?.toLowerCase().includes('vfd')`. `SensorType` is a
 * fifteen-value database enum and none of its values contains "vfd", so the
 * condition could never be true: the only place in the product with drive
 * controls could not render. The gate was not merely wrong, it was asking the
 * wrong entity — a VFD is a `VfdDevice`, not a `Sensor`. It now lives on the VFD
 * device page, where the thing on screen IS a drive and no type sniffing is
 * needed.
 *
 * SENSOR-HIGH-067: the freshness indicator used to be a pulsing dot titled
 * "Canlı veri", shown whenever the CLIENT was polling. The client polls every
 * three seconds regardless, so the dot was always on — while no backend job ever
 * read a drive, meaning `vfd_readings` did not change between polls. It reported
 * the browser's activity as if it were the data's.
 *
 * `VfdTelemetryPollerService` now refreshes those rows on each drive's own
 * `poll_interval_ms`, so the data really does move. This still shows the age of
 * the READING rather than a "live" badge, because that remains the honest signal:
 * a drive whose edge read is failing stops producing rows, and the number an
 * operator needs before touching a motor is how old the last one is.
 */
import React from 'react';
import { Zap, Play, Square, AlertOctagon, RefreshCw, AlertCircle } from 'lucide-react';

import { useVfdRealtimeReadings, getVfdStatus } from '../../hooks/useVfdReadings';
import { useVfdCommands } from '../../hooks/useVfdCommands';
import { VfdDeviceStatus } from '../../types/vfd.types';
import { Spinner, Button } from '@aquaculture/shared-ui';

/** Beyond this the reading is old enough that acting on it is a decision, not a reflex. */
const STALE_AFTER_MS = 30_000;

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} sn önce`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} dk önce`;
  return `${Math.round(ms / 3_600_000)} sa önce`;
}

export interface VfdControlPanelProps {
  readonly deviceId: string;
  /** The drive's lifecycle status. Commands require ACTIVE — the backend enforces it. */
  readonly deviceStatus: VfdDeviceStatus | string;
}

export const VfdControlPanel: React.FC<VfdControlPanelProps> = ({ deviceId, deviceStatus }) => {
  const { reading, error: readingError } = useVfdRealtimeReadings(deviceId, {
    enabled: true,
    pollInterval: 3000,
  });
  const {
    loading: cmdLoading,
    lastResult,
    start,
    stop,
    emergencyStop,
    resetFault,
  } = useVfdCommands(deviceId);

  const vfdStatus = getVfdStatus(reading?.statusBits);
  const params = reading?.parameters;

  // vfd-command.service.ts rejects any command on a drive that is not ACTIVE.
  // Mirroring that here means the buttons say so instead of the operator
  // discovering it from a failed request on equipment they meant to stop.
  const commandsEnabled = deviceStatus === VfdDeviceStatus.ACTIVE;

  const readingAgeMs = reading ? Date.now() - new Date(reading.timestamp).getTime() : undefined;
  const readingIsStale = readingAgeMs === undefined || readingAgeMs > STALE_AFTER_MS;

  const STATUS_COLORS = {
    running:
      'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200 border-success-200 dark:border-success-800',
    ready:
      'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200 border-info-200 dark:border-info-800',
    fault:
      'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200 border-error-200 dark:border-error-800',
    warning:
      'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200 border-warning-200 dark:border-warning-800',
    stopped:
      'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700',
  };

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <Zap className="w-5 h-5 text-primary-500" />
          VFD Durumu
        </h3>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${STATUS_COLORS[vfdStatus.status]}`}
          >
            {vfdStatus.label}
          </span>
          {/* The age of the DATA, not of the browser's poll loop. */}
          <span
            className={`text-xs ${readingIsStale ? 'text-warning-600 dark:text-warning-400' : 'text-gray-500 dark:text-gray-400'}`}
            data-testid="vfd-reading-age"
          >
            {readingAgeMs === undefined ? 'Okuma yok' : `Okuma: ${formatAge(readingAgeMs)}`}
          </span>
        </div>
      </div>

      {readingError && (
        <div className="mb-4 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg px-3 py-2 text-sm text-error-700 dark:text-error-300 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {readingError.message}
        </div>
      )}

      {/* Readings Grid */}
      {params && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {params.outputFrequency != null && (
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500 dark:text-gray-400">Frekans</p>
              <p className="font-semibold text-gray-900 dark:text-gray-100">
                {params.outputFrequency.toFixed(1)} Hz
              </p>
            </div>
          )}
          {params.motorSpeed != null && (
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500 dark:text-gray-400">Motor Hızı</p>
              <p className="font-semibold text-gray-900 dark:text-gray-100">
                {Math.round(params.motorSpeed)} RPM
              </p>
            </div>
          )}
          {params.motorCurrent != null && (
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500 dark:text-gray-400">Akim</p>
              <p className="font-semibold text-gray-900 dark:text-gray-100">
                {params.motorCurrent.toFixed(2)} A
              </p>
            </div>
          )}
          {params.outputPower != null && (
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500 dark:text-gray-400">Güç</p>
              <p className="font-semibold text-gray-900 dark:text-gray-100">
                {params.outputPower.toFixed(2)} kW
              </p>
            </div>
          )}
          {params.driveTemperature != null && (
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500 dark:text-gray-400">Sürücü Sıcaklığı</p>
              <p className="font-semibold text-gray-900 dark:text-gray-100">
                {params.driveTemperature.toFixed(1)} °C
              </p>
            </div>
          )}
          {params.motorVoltage != null && (
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500 dark:text-gray-400">Gerilim</p>
              <p className="font-semibold text-gray-900 dark:text-gray-100">
                {params.motorVoltage.toFixed(1)} V
              </p>
            </div>
          )}
          {params.energyConsumption != null && (
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500 dark:text-gray-400">Enerji</p>
              <p className="font-semibold text-gray-900 dark:text-gray-100">
                {params.energyConsumption.toFixed(2)} kWh
              </p>
            </div>
          )}
          {params.runningHours != null && (
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500 dark:text-gray-400">Çalışma Saati</p>
              <p className="font-semibold text-gray-900 dark:text-gray-100">
                {Math.round(params.runningHours)} h
              </p>
            </div>
          )}
        </div>
      )}

      {!reading && !readingError && (
        <p className="text-sm text-gray-400 dark:text-gray-500 mb-4">
          VFD okuma verisi bekleniyor...
        </p>
      )}

      {!commandsEnabled && (
        <div
          className="mb-3 bg-warning-50 dark:bg-warning-900/20 border border-warning-200 dark:border-warning-800 rounded-lg px-3 py-2 text-sm text-warning-800 dark:text-warning-200"
          data-testid="vfd-commands-disabled-notice"
        >
          Sürücü etkin değil ({deviceStatus}). Komut göndermek için sürücüyü etkinleştirin.
        </div>
      )}

      {/* Command Buttons */}
      <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-gray-100 dark:border-gray-700">
        <Button
          variant="primary"
          size="sm"
          onClick={start}
          disabled={!commandsEnabled || cmdLoading || vfdStatus.status === 'running'}
        >
          {cmdLoading ? <Spinner size="sm" color="inherit" /> : <Play className="w-3.5 h-3.5" />}
          Başlat
        </Button>
        <button
          onClick={stop}
          disabled={!commandsEnabled || cmdLoading || vfdStatus.status === 'stopped'}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-600 text-white rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors disabled:opacity-50"
        >
          {cmdLoading ? <Spinner size="sm" color="inherit" /> : <Square className="w-3.5 h-3.5" />}
          Durdur
        </button>
        {vfdStatus.status === 'fault' && (
          <Button
            variant="warning"
            size="sm"
            onClick={resetFault}
            disabled={!commandsEnabled || cmdLoading}
          >
            {cmdLoading ? (
              <Spinner size="sm" color="inherit" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Arızayı Sıfırla
          </Button>
        )}
        <Button
          variant="danger"
          size="sm"
          onClick={emergencyStop}
          disabled={!commandsEnabled || cmdLoading}
        >
          {cmdLoading ? (
            <Spinner size="sm" color="inherit" />
          ) : (
            <AlertOctagon className="w-3.5 h-3.5" />
          )}
          Acil Dur
        </Button>
      </div>

      {/* Last Command Result */}
      {lastResult && !lastResult.success && (
        <div className="mt-3 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg px-3 py-2 text-sm text-error-700 dark:text-error-300">
          Komut hatasi: {lastResult.error}
        </div>
      )}
      {lastResult?.success && (
        <div className="mt-3 bg-success-50 dark:bg-success-900/20 border border-success-200 dark:border-success-800 rounded-lg px-3 py-2 text-sm text-success-700 dark:text-success-300">
          Komut başarıyla gönderildi
        </div>
      )}
    </div>
  );
};

export default VfdControlPanel;
