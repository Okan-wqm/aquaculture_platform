/**
 * VFD Device Detail Page (SENSOR-CRITICAL-003)
 *
 * Reads a registered VFD drive back by id through the tenant-scoped
 * `vfdDevice(id)` query so every field the registration wizard wrote
 * (brand, model, serial, protocol config, location, notes, poll settings)
 * is observable. Previously `/sensor/devices/:id` resolved a VFD as a
 * sensor and rendered "Sensör yüklenemedi".
 */

import React from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Zap,
  Wifi,
  WifiOff,
  Loader2,
  AlertTriangle,
  MapPin,
  Clock,
  Activity,
} from 'lucide-react';

import { useVfdDevice } from '../hooks/useVfdRegistration';
import { VFD_BRAND_NAMES, VFD_PROTOCOL_NAMES } from '../types/vfd.types';

const Field: React.FC<{ label: string; value?: React.ReactNode }> = ({ label, value }) => (
  <div>
    <p className="text-xs uppercase tracking-wide text-gray-400">{label}</p>
    <p className="text-sm font-medium text-gray-900">{value ?? 'Belirtilmemiş'}</p>
  </div>
);

export const VfdDeviceDetailPage: React.FC = () => {
  const { deviceId } = useParams<{ deviceId: string }>();
  const { data: device, isLoading, error, refetch } = useVfdDevice(deviceId);

  if (isLoading) {
    return (
      <div className="p-12 flex flex-col items-center justify-center text-gray-500">
        <Loader2 className="w-8 h-8 animate-spin mb-3" />
        <p>VFD cihazı yükleniyor...</p>
      </div>
    );
  }

  if (error || !device) {
    return (
      <div className="p-6">
        <Link to="/sensor/devices" className="inline-flex items-center gap-2 text-cyan-600 mb-6">
          <ArrowLeft className="w-4 h-4" /> Cihazlara Dön
        </Link>
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500" />
          <div>
            <p className="text-red-800 font-medium">VFD cihazı yüklenemedi</p>
            {error && <p className="text-red-600 text-sm">{(error as Error).message}</p>}
          </div>
          <button
            onClick={() => refetch()}
            className="ml-auto px-3 py-1 bg-red-100 text-red-700 rounded hover:bg-red-200"
          >
            Tekrar Dene
          </button>
        </div>
      </div>
    );
  }

  const connected = device.connectionStatus?.isConnected;

  return (
    <div className="p-6 space-y-6">
      <Link to="/sensor/devices" className="inline-flex items-center gap-2 text-cyan-600">
        <ArrowLeft className="w-4 h-4" /> Cihazlara Dön
      </Link>

      {/* Header */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 flex items-center gap-4">
        <div className="w-12 h-12 rounded-lg bg-cyan-50 flex items-center justify-center">
          <Zap className="w-6 h-6 text-cyan-600" />
        </div>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-gray-900">{device.name}</h1>
          <p className="text-sm text-gray-500">
            {VFD_BRAND_NAMES[device.brand] ?? device.brand}
            {' · '}
            {VFD_PROTOCOL_NAMES[device.protocol] ?? device.protocol}
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${
            connected ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
          }`}
        >
          {connected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
          {connected ? 'Çevrimiçi' : 'Çevrimdışı'}
        </span>
        <span className="text-xs font-medium px-2.5 py-0.5 rounded-full bg-gray-100 text-gray-700">
          {device.status}
        </span>
      </div>

      {/* Identity */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 grid grid-cols-2 md:grid-cols-3 gap-4">
        <Field label="Marka" value={VFD_BRAND_NAMES[device.brand] ?? device.brand} />
        <Field label="Model" value={device.model} />
        <Field label="Seri No" value={device.serialNumber} />
        <Field label="Protokol" value={VFD_PROTOCOL_NAMES[device.protocol] ?? device.protocol} />
        <Field
          label="Konum"
          value={
            device.location ? (
              <span className="inline-flex items-center gap-1">
                <MapPin className="w-3 h-3 text-gray-400" /> {device.location}
              </span>
            ) : undefined
          }
        />
        <Field
          label="Poll Aralığı"
          value={
            <span className="inline-flex items-center gap-1">
              <Clock className="w-3 h-3 text-gray-400" /> {device.pollIntervalMs} ms
              {device.isPollingEnabled ? '' : ' (kapalı)'}
            </span>
          }
        />
      </div>

      {/* Description */}
      {device.description && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">Açıklama / Notlar</p>
          <p className="text-sm text-gray-900 whitespace-pre-wrap">{device.description}</p>
        </div>
      )}

      {/* Latest reading */}
      {device.latestReading && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <p className="text-sm font-semibold text-gray-900 mb-3 inline-flex items-center gap-2">
            <Activity className="w-4 h-4 text-cyan-600" /> Son Okuma
          </p>
          <pre className="text-xs bg-gray-50 rounded-lg p-3 overflow-x-auto">
            {JSON.stringify(device.latestReading.parameters, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
};

export default VfdDeviceDetailPage;
