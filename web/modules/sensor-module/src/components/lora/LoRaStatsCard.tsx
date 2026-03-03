/**
 * LoRa istatistik karti
 * Aktif cihaz sayisi, toplam uplink, join ve hata istatistiklerini gosterir.
 */

import React from 'react';
import { Radio, ArrowUpCircle, Link2, AlertTriangle } from 'lucide-react';
import type { LoRaDevice } from '../../hooks/useLoRaDevices';

interface LoRaStatsCardProps {
  devices: LoRaDevice[];
}

const LoRaStatsCard: React.FC<LoRaStatsCardProps> = ({ devices }) => {
  const total = devices.length;
  const joined = devices.filter((d) => d.isJoined).length;
  const totalUplinks = devices.reduce((sum, d) => sum + (d.frameCountUp ?? 0), 0);
  const joinCount = devices.filter((d) => d.joinedAt).length;

  // Aktif cihaz orani (progress bar icin)
  const pct = total > 0 ? Math.round((joined / total) * 100) : 0;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <div className="flex items-center gap-2 mb-4">
        <Radio className="w-5 h-5 text-cyan-600" />
        <h3 className="text-lg font-semibold text-gray-900">LoRa Ozet</h3>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* Aktif Cihaz */}
        <div>
          <p className="text-sm text-gray-500 mb-1">Aktif Cihaz</p>
          <p className="text-2xl font-bold text-gray-900">
            {joined} <span className="text-sm font-normal text-gray-400">/ {total}</span>
          </p>
          <div className="mt-2 h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full bg-cyan-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {/* Toplam Uplink */}
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
            <ArrowUpCircle className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <p className="text-sm text-gray-500">Toplam Uplink</p>
            <p className="text-xl font-bold text-gray-900">{totalUplinks.toLocaleString('tr-TR')}</p>
          </div>
        </div>

        {/* Join Sayisi */}
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-green-50 flex items-center justify-center shrink-0">
            <Link2 className="w-5 h-5 text-green-600" />
          </div>
          <div>
            <p className="text-sm text-gray-500">Join Sayisi</p>
            <p className="text-xl font-bold text-gray-900">{joinCount}</p>
          </div>
        </div>

        {/* Bekleyen (pending join) */}
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-yellow-50 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-yellow-600" />
          </div>
          <div>
            <p className="text-sm text-gray-500">Bekleyen</p>
            <p className="text-xl font-bold text-gray-900">{total - joined}</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoRaStatsCard;
