/**
 * Alerts Page
 *
 * Sensör uyarıları sayfası.
 */

import React, { useState } from 'react';
import {
  AlertTriangle,
  Bell,
  CheckCircle,
  Clock,
  Filter,
  XCircle,
  ChevronRight,
  Thermometer,
  Droplets,
} from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

interface Alert {
  id: string;
  sensorId: string;
  sensorName: string;
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'active' | 'acknowledged' | 'resolved';
  message: string;
  value: number;
  threshold: number;
  unit: string;
  timestamp: string;
  acknowledgedBy?: string;
  resolvedAt?: string;
}

// ============================================================================
// Mock Data
// ============================================================================

const mockAlerts: Alert[] = [
  {
    id: '1',
    sensorId: '5',
    sensorName: 'Havuz C - Sıcaklık',
    type: 'temperature',
    severity: 'critical',
    status: 'active',
    message: 'Sıcaklık kritik seviyeyi aştı',
    value: 28.5,
    threshold: 26,
    unit: '°C',
    timestamp: '2024-01-15T14:30:00',
  },
  {
    id: '2',
    sensorId: '3',
    sensorName: 'Havuz B - pH',
    type: 'ph',
    severity: 'high',
    status: 'acknowledged',
    message: 'pH seviyesi düşük',
    value: 6.2,
    threshold: 6.5,
    unit: 'pH',
    timestamp: '2024-01-15T14:15:00',
    acknowledgedBy: 'Ahmet Yılmaz',
  },
  {
    id: '3',
    sensorId: '6',
    sensorName: 'Havuz C - Oksijen',
    type: 'dissolved_oxygen',
    severity: 'medium',
    status: 'active',
    message: 'Oksijen seviyesi düşüyor',
    value: 6.5,
    threshold: 7.0,
    unit: 'mg/L',
    timestamp: '2024-01-15T14:00:00',
  },
  {
    id: '4',
    sensorId: '1',
    sensorName: 'Havuz A - Sıcaklık',
    type: 'temperature',
    severity: 'low',
    status: 'resolved',
    message: 'Sıcaklık eşik değerine yaklaşıyor',
    value: 24.8,
    threshold: 25,
    unit: '°C',
    timestamp: '2024-01-15T12:00:00',
    resolvedAt: '2024-01-15T12:30:00',
  },
];

// ============================================================================
// Components
// ============================================================================

const SeverityBadge: React.FC<{ severity: Alert['severity'] }> = ({ severity }) => {
  const config = {
    critical: { label: 'Kritik', className: 'bg-red-100 text-red-800 border-red-200' },
    high: { label: 'Yüksek', className: 'bg-orange-100 text-orange-800 border-orange-200' },
    medium: { label: 'Orta', className: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
    low: { label: 'Düşük', className: 'bg-blue-100 text-blue-800 border-blue-200' },
  };

  const { label, className } = config[severity];

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${className}`}>
      {label}
    </span>
  );
};

const StatusBadge: React.FC<{ status: Alert['status'] }> = ({ status }) => {
  const config = {
    active: { label: 'Aktif', icon: AlertTriangle, className: 'text-red-600' },
    acknowledged: { label: 'Onaylandı', icon: Clock, className: 'text-yellow-600' },
    resolved: { label: 'Çözüldü', icon: CheckCircle, className: 'text-green-600' },
  };

  const { label, icon: Icon, className } = config[status];

  return (
    <span className={`inline-flex items-center gap-1 text-sm font-medium ${className}`}>
      <Icon className="w-4 h-4" />
      {label}
    </span>
  );
};

// ============================================================================
// Alerts Page
// ============================================================================

const AlertsPage: React.FC = () => {
  const [selectedSeverity, setSelectedSeverity] = useState('all');
  const [selectedStatus, setSelectedStatus] = useState('all');

  const filteredAlerts = mockAlerts.filter((alert) => {
    const matchesSeverity = selectedSeverity === 'all' || alert.severity === selectedSeverity;
    const matchesStatus = selectedStatus === 'all' || alert.status === selectedStatus;
    return matchesSeverity && matchesStatus;
  });

  const activeCount = mockAlerts.filter((a) => a.status === 'active').length;
  const criticalCount = mockAlerts.filter((a) => a.severity === 'critical' && a.status === 'active').length;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Uyarılar</h1>
          <p className="text-gray-500 mt-1">
            {activeCount > 0 ? (
              <span className="text-red-600 font-medium">{activeCount} aktif uyarı</span>
            ) : (
              'Aktif uyarı yok'
            )}
            {criticalCount > 0 && (
              <span className="text-red-600 font-medium"> ({criticalCount} kritik)</span>
            )}
          </p>
        </div>
        <button className="flex items-center gap-2 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors">
          <Bell className="w-4 h-4" />
          Bildirim Ayarları
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-red-50 border border-red-100 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-8 h-8 text-red-600" />
            <div>
              <p className="text-2xl font-bold text-red-900">
                {mockAlerts.filter((a) => a.severity === 'critical').length}
              </p>
              <p className="text-sm text-red-600">Kritik</p>
            </div>
          </div>
        </div>
        <div className="bg-orange-50 border border-orange-100 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-8 h-8 text-orange-600" />
            <div>
              <p className="text-2xl font-bold text-orange-900">
                {mockAlerts.filter((a) => a.severity === 'high').length}
              </p>
              <p className="text-sm text-orange-600">Yüksek</p>
            </div>
          </div>
        </div>
        <div className="bg-yellow-50 border border-yellow-100 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <Clock className="w-8 h-8 text-yellow-600" />
            <div>
              <p className="text-2xl font-bold text-yellow-900">
                {mockAlerts.filter((a) => a.status === 'acknowledged').length}
              </p>
              <p className="text-sm text-yellow-600">Beklemede</p>
            </div>
          </div>
        </div>
        <div className="bg-green-50 border border-green-100 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <CheckCircle className="w-8 h-8 text-green-600" />
            <div>
              <p className="text-2xl font-bold text-green-900">
                {mockAlerts.filter((a) => a.status === 'resolved').length}
              </p>
              <p className="text-sm text-green-600">Çözülen</p>
            </div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5 text-gray-400" />
            <select
              value={selectedSeverity}
              onChange={(e) => setSelectedSeverity(e.target.value)}
              className="px-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
            >
              <option value="all">Tüm Önem Dereceleri</option>
              <option value="critical">Kritik</option>
              <option value="high">Yüksek</option>
              <option value="medium">Orta</option>
              <option value="low">Düşük</option>
            </select>
          </div>
          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className="px-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
          >
            <option value="all">Tüm Durumlar</option>
            <option value="active">Aktif</option>
            <option value="acknowledged">Onaylanmış</option>
            <option value="resolved">Çözülmüş</option>
          </select>
        </div>
      </div>

      {/* Alerts List */}
      <div className="space-y-4">
        {filteredAlerts.map((alert) => (
          <div
            key={alert.id}
            className={`bg-white rounded-xl shadow-sm border-l-4 p-6 hover:shadow-md transition-shadow ${
              alert.severity === 'critical' ? 'border-l-red-500' :
              alert.severity === 'high' ? 'border-l-orange-500' :
              alert.severity === 'medium' ? 'border-l-yellow-500' : 'border-l-blue-500'
            }`}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-4">
                <div className={`p-3 rounded-lg ${
                  alert.type === 'temperature' ? 'bg-orange-100' : 'bg-blue-100'
                }`}>
                  {alert.type === 'temperature' ? (
                    <Thermometer className="w-6 h-6 text-orange-600" />
                  ) : (
                    <Droplets className="w-6 h-6 text-blue-600" />
                  )}
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold text-gray-900">{alert.sensorName}</h3>
                    <SeverityBadge severity={alert.severity} />
                  </div>
                  <p className="text-gray-600">{alert.message}</p>
                  <div className="flex items-center gap-4 mt-2 text-sm text-gray-500">
                    <span>
                      Değer: <strong className="text-gray-900">{alert.value} {alert.unit}</strong>
                    </span>
                    <span>
                      Eşik: <strong className="text-gray-900">{alert.threshold} {alert.unit}</strong>
                    </span>
                  </div>
                  {alert.acknowledgedBy && (
                    <p className="text-sm text-gray-500 mt-1">
                      Onaylayan: {alert.acknowledgedBy}
                    </p>
                  )}
                </div>
              </div>
              <div className="text-right">
                <StatusBadge status={alert.status} />
                <p className="text-sm text-gray-500 mt-2">
                  {new Date(alert.timestamp).toLocaleString('tr-TR')}
                </p>
              </div>
            </div>

            {alert.status === 'active' && (
              <div className="flex items-center justify-end gap-2 mt-4 pt-4 border-t border-gray-100">
                <button className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
                  Yoksay
                </button>
                <button className="px-4 py-2 bg-yellow-100 text-yellow-700 hover:bg-yellow-200 rounded-lg transition-colors">
                  Onayla
                </button>
                <button className="px-4 py-2 bg-green-600 text-white hover:bg-green-700 rounded-lg transition-colors">
                  Çözüldü İşaretle
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default AlertsPage;
