/**
 * Calibration Page
 *
 * Sensör kalibrasyon yönetim sayfası.
 *
 * NOTE: Real calibration API integration is not yet implemented.
 * This page is gated behind an informational banner until the backend
 * calibration endpoints are available (BUG-001 / CRIT-2 fix).
 */

import React from 'react';
import { Settings, AlertCircle } from 'lucide-react';

// ============================================================================
// Calibration Page
// ============================================================================

const CalibrationPage: React.FC = () => {
  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Kalibrasyon Yönetimi</h1>
          <p className="text-gray-500 mt-1">Sensör kalibrasyon takibi ve planlama</p>
        </div>
        <div className="p-3 bg-gray-100 rounded-lg">
          <Settings className="w-6 h-6 text-gray-400" />
        </div>
      </div>

      {/* Not-yet-implemented notice */}
      <div className="flex items-start gap-4 p-5 bg-yellow-50 border border-yellow-200 rounded-xl">
        <AlertCircle className="w-6 h-6 text-yellow-600 mt-0.5 shrink-0" />
        <div>
          <p className="font-semibold text-yellow-800">Kalibrasyon modülü henüz kullanıma hazır değil</p>
          <p className="mt-1 text-sm text-yellow-700">
            Gerçek kalibrasyon verileri ve kayıt işlemleri yakında aktif edilecektir.
            Lütfen bu sayfa hizmet dışıyken kalibrasyon durumunu kontrol etmek için
            sistem yöneticinize başvurun.
          </p>
        </div>
      </div>
    </div>
  );
};

export default CalibrationPage;
