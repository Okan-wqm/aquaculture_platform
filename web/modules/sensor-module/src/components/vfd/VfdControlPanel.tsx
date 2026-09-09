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
import { Zap, Play, Square, AlertOctagon, RefreshCw, Loader2, AlertCircle } from 'lucide-react';

import { useVfdRealtimeReadings, getVfdStatus } from '../../hooks/useVfdReadings';
import { useVfdCommands } from '../../hooks/useVfdCommands';
import { VfdDeviceStatus } from '../../types/vfd.types';

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
    running: 'bg-green-100 text-green-800 border-green-200',
    ready: 'bg-blue-100 text-blue-800 border-blue-200',
    fault: 'bg-red-100 text-red-800 border-red-200',
    warning: 'bg-yellow-100 text-yellow-800 border-yellow-200',
    stopped: 'bg-gray-100 text-gray-700 border-gray-200',
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <Zap className="w-5 h-5 text-indigo-500" />
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
            className={`text-xs ${readingIsStale ? 'text-amber-600' : 'text-gray-500'}`}
            data-testid="vfd-reading-age"
          >
            {readingAgeMs === undefined ? 'Okuma yok' : `Okuma: ${formatAge(readingAgeMs)}`}
          </span>
        </div>
      </div>

      {readingError && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {readingError.message}
        </div>
      )}

      {/* Readings Grid */}
      {params && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {params.outputFrequency != null && (
            <div className="bg-gray-50 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500">Frekans</p>
              <p className="font-semibold text-gray-900">{params.outputFrequency.toFixed(1)} Hz</p>
            </div>
          )}
          {params.motorSpeed != null && (
            <div className="bg-gray-50 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500">Motor Hızı</p>
              <p className="font-semibold text-gray-900">{Math.round(params.motorSpeed)} RPM</p>
            </div>
          )}
          {params.motorCurrent != null && (
            <div className="bg-gray-50 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500">Akim</p>
              <p className="font-semibold text-gray-900">{params.motorCurrent.toFixed(2)} A</p>
            </div>
          )}
          {params.outputPower != null && (
            <div className="bg-gray-50 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500">Güç</p>
              <p className="font-semibold text-gray-900">{params.outputPower.toFixed(2)} kW</p>
            </div>
          )}
          {params.driveTemperature != null && (
            <div className="bg-gray-50 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500">Sürücü Sıcaklığı</p>
              <p className="font-semibold text-gray-900">{params.driveTemperature.toFixed(1)} °C</p>
            </div>
          )}
          {params.motorVoltage != null && (
            <div className="bg-gray-50 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500">Gerilim</p>
              <p className="font-semibold text-gray-900">{params.motorVoltage.toFixed(1)} V</p>
            </div>
          )}
          {params.energyConsumption != null && (
            <div className="bg-gray-50 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500">Enerji</p>
              <p className="font-semibold text-gray-900">
                {params.energyConsumption.toFixed(2)} kWh
              </p>
            </div>
          )}
          {params.runningHours != null && (
            <div className="bg-gray-50 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500">Çalışma Saati</p>
              <p className="font-semibold text-gray-900">{Math.round(params.runningHours)} h</p>
            </div>
          )}
        </div>
      )}

      {!reading && !readingError && (
        <p className="text-sm text-gray-400 mb-4">VFD okuma verisi bekleniyor...</p>
      )}

      {!commandsEnabled && (
        <div
          className="mb-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-800"
          data-testid="vfd-commands-disabled-notice"
        >
          Sürücü etkin değil ({deviceStatus}). Komut göndermek için sürücüyü etkinleştirin.
        </div>
      )}

      {/* Command Buttons */}
      <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-gray-100">
        <button
          onClick={start}
          disabled={!commandsEnabled || cmdLoading || vfdStatus.status === 'running'}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition-colors disabled:opacity-50"
        >
          {cmdLoading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Play className="w-3.5 h-3.5" />
          )}
          Başlat
        </button>
        <button
          onClick={stop}
          disabled={!commandsEnabled || cmdLoading || vfdStatus.status === 'stopped'}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-600 text-white rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors disabled:opacity-50"
        >
          {cmdLoading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Square className="w-3.5 h-3.5" />
          )}
          Durdur
        </button>
        {vfdStatus.status === 'fault' && (
          <button
            onClick={resetFault}
            disabled={!commandsEnabled || cmdLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-600 text-white rounded-lg text-sm font-medium hover:bg-yellow-700 transition-colors disabled:opacity-50"
          >
            {cmdLoading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Arızayı Sıfırla
          </button>
        )}
        <button
          onClick={emergencyStop}
          disabled={!commandsEnabled || cmdLoading}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50 ml-auto"
        >
          {cmdLoading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <AlertOctagon className="w-3.5 h-3.5" />
          )}
          Acil Dur
        </button>
      </div>

      {/* Last Command Result */}
      {lastResult && !lastResult.success && (
        <div className="mt-3 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">
          Komut hatasi: {lastResult.error}
        </div>
      )}
      {lastResult?.success && (
        <div className="mt-3 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm text-green-700">
          Komut başarıyla gönderildi
        </div>
      )}
    </div>
  );
};

export default VfdControlPanel;
