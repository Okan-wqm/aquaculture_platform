/**
 * Calibration Page
 *
 * Sensör kalibrasyon yönetim sayfası.
 */

import React from 'react';
import { Settings, Calendar, CheckCircle, AlertCircle, Clock, Plus, Cpu, FileText } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

interface CalibrationRecord {
  id: string;
  sensorId: string;
  sensorName: string;
  sensorType: string;
  lastCalibration: string;
  nextCalibration: string;
  status: 'ok' | 'due' | 'overdue';
  calibratedBy: string;
  notes: string;
}

// ============================================================================
// Mock Data
// ============================================================================

const mockCalibrations: CalibrationRecord[] = [
  { id: '1', sensorId: '1', sensorName: 'Sıcaklık Sensörü A1', sensorType: 'temperature', lastCalibration: '2024-01-01', nextCalibration: '2024-04-01', status: 'ok', calibratedBy: 'Ahmet Yılmaz', notes: 'Standart kalibrasyon' },
  { id: '2', sensorId: '2', sensorName: 'Oksijen Sensörü A1', sensorType: 'dissolved_oxygen', lastCalibration: '2023-12-15', nextCalibration: '2024-01-15', status: 'due', calibratedBy: 'Ayşe Kaya', notes: 'Membran değişimi yapıldı' },
  { id: '3', sensorId: '3', sensorName: 'pH Sensörü B1', sensorType: 'ph', lastCalibration: '2023-11-01', nextCalibration: '2024-01-01', status: 'overdue', calibratedBy: 'Mehmet Demir', notes: 'Buffer 4.0 ve 7.0 kullanıldı' },
  { id: '4', sensorId: '4', sensorName: 'Tuzluluk Sensörü B1', sensorType: 'salinity', lastCalibration: '2024-01-10', nextCalibration: '2024-04-10', status: 'ok', calibratedBy: 'Fatma Şahin', notes: 'Referans solüsyon ile' },
  { id: '5', sensorId: '6', sensorName: 'Bulanıklık Sensörü C1', sensorType: 'turbidity', lastCalibration: '2023-10-01', nextCalibration: '2023-12-01', status: 'overdue', calibratedBy: 'Ali Öztürk', notes: 'NTU standardı kullanıldı' },
];

// ============================================================================
// Components
// ============================================================================

const StatusBadge: React.FC<{ status: CalibrationRecord['status'] }> = ({ status }) => {
  const config = {
    ok: { label: 'Güncel', icon: CheckCircle, className: 'bg-green-100 text-green-800' },
    due: { label: 'Yaklaşıyor', icon: Clock, className: 'bg-yellow-100 text-yellow-800' },
    overdue: { label: 'Gecikmiş', icon: AlertCircle, className: 'bg-red-100 text-red-800' },
  };

  const { label, icon: Icon, className } = config[status];

  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${className}`}>
      <Icon className="w-3 h-3" />
      {label}
    </span>
  );
};

// ============================================================================
// Calibration Page
// ============================================================================

const CalibrationPage: React.FC = () => {
  const overdueCount = mockCalibrations.filter((c) => c.status === 'overdue').length;
  const dueCount = mockCalibrations.filter((c) => c.status === 'due').length;
  const okCount = mockCalibrations.filter((c) => c.status === 'ok').length;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Kalibrasyon Yönetimi</h1>
          <p className="text-gray-500 mt-1">Sensör kalibrasyon takibi ve planlama</p>
        </div>
        <button className="flex items-center gap-2 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors">
          <Plus className="w-4 h-4" />
          Kalibrasyon Ekle
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-red-50 border border-red-100 rounded-xl p-6">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-red-100 rounded-lg">
              <AlertCircle className="w-6 h-6 text-red-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-red-900">{overdueCount}</p>
              <p className="text-sm text-red-600">Gecikmiş Kalibrasyon</p>
            </div>
          </div>
        </div>
        <div className="bg-yellow-50 border border-yellow-100 rounded-xl p-6">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-yellow-100 rounded-lg">
              <Clock className="w-6 h-6 text-yellow-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-yellow-900">{dueCount}</p>
              <p className="text-sm text-yellow-600">Yaklaşan Kalibrasyon</p>
            </div>
          </div>
        </div>
        <div className="bg-green-50 border border-green-100 rounded-xl p-6">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-green-100 rounded-lg">
              <CheckCircle className="w-6 h-6 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-green-900">{okCount}</p>
              <p className="text-sm text-green-600">Güncel</p>
            </div>
          </div>
        </div>
      </div>

      {/* Calibration List */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-4 border-b border-gray-100">
          <h3 className="font-semibold text-gray-900">Kalibrasyon Kayıtları</h3>
        </div>
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              <th className="text-left px-6 py-4 text-sm font-medium text-gray-500">Sensör</th>
              <th className="text-left px-6 py-4 text-sm font-medium text-gray-500">Son Kalibrasyon</th>
              <th className="text-left px-6 py-4 text-sm font-medium text-gray-500">Sonraki</th>
              <th className="text-center px-6 py-4 text-sm font-medium text-gray-500">Durum</th>
              <th className="text-left px-6 py-4 text-sm font-medium text-gray-500">Kalibre Eden</th>
              <th className="text-right px-6 py-4 text-sm font-medium text-gray-500">İşlemler</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {mockCalibrations.map((record) => (
              <tr
                key={record.id}
                className={`hover:bg-gray-50 transition-colors ${
                  record.status === 'overdue' ? 'bg-red-50' : ''
                }`}
              >
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-cyan-100 rounded-lg">
                      <Cpu className="w-5 h-5 text-cyan-600" />
                    </div>
                    <div>
                      <p className="font-medium text-gray-900">{record.sensorName}</p>
                      <p className="text-sm text-gray-500">{record.sensorType}</p>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2 text-gray-600">
                    <Calendar className="w-4 h-4" />
                    {new Date(record.lastCalibration).toLocaleDateString('tr-TR')}
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2 text-gray-600">
                    <Calendar className="w-4 h-4" />
                    {new Date(record.nextCalibration).toLocaleDateString('tr-TR')}
                  </div>
                </td>
                <td className="px-6 py-4 text-center">
                  <StatusBadge status={record.status} />
                </td>
                <td className="px-6 py-4 text-gray-600">{record.calibratedBy}</td>
                <td className="px-6 py-4 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button className="p-2 text-gray-400 hover:text-cyan-600 hover:bg-cyan-50 rounded-lg transition-colors">
                      <FileText className="w-4 h-4" />
                    </button>
                    <button className="px-3 py-1 text-sm bg-cyan-100 text-cyan-700 hover:bg-cyan-200 rounded-lg transition-colors">
                      Kalibre Et
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default CalibrationPage;
