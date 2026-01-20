/**
 * Growth Tab
 * Growth samples and metrics tracking
 */
import React, { useState } from 'react';

// Mock growth data
const mockGrowthSamples = [
  {
    id: '1',
    batchNumber: 'B-2024-00001',
    tankName: 'Tank A1',
    measurementDate: new Date('2024-06-15'),
    sampleSize: 50,
    avgWeight: 145,
    avgLength: 22.5,
    weightCV: 12.5,
    sgr: 2.5,
    performance: 'good',
    measuredBy: 'Ali Yılmaz',
  },
  {
    id: '2',
    batchNumber: 'B-2024-00001',
    tankName: 'Tank A2',
    measurementDate: new Date('2024-06-15'),
    sampleSize: 45,
    avgWeight: 142,
    avgLength: 22.0,
    weightCV: 14.2,
    sgr: 2.3,
    performance: 'average',
    measuredBy: 'Mehmet Demir',
  },
  {
    id: '3',
    batchNumber: 'B-2024-00002',
    tankName: 'Tank B1',
    measurementDate: new Date('2024-06-14'),
    sampleSize: 40,
    avgWeight: 195,
    avgLength: 26.5,
    weightCV: 11.8,
    sgr: 2.2,
    performance: 'good',
    measuredBy: 'Ali Yılmaz',
  },
];

const mockBatchGrowth = [
  {
    batchNumber: 'B-2024-00001',
    speciesName: 'Atlantic Salmon',
    currentWeight: 145,
    targetWeight: 150,
    initialWeight: 5,
    daysInProduction: 152,
    sgr: 2.5,
    fcr: 1.25,
    growthStatus: 'on_track',
  },
  {
    batchNumber: 'B-2024-00002',
    speciesName: 'Rainbow Trout',
    currentWeight: 195,
    targetWeight: 200,
    initialWeight: 10,
    daysInProduction: 135,
    sgr: 2.2,
    fcr: 1.18,
    growthStatus: 'on_track',
  },
];

const performanceLabels: Record<string, { label: string; color: string }> = {
  excellent: { label: 'Mükemmel', color: 'bg-green-100 text-green-800' },
  good: { label: 'İyi', color: 'bg-blue-100 text-blue-800' },
  average: { label: 'Orta', color: 'bg-yellow-100 text-yellow-800' },
  below_average: { label: 'Ortalamanın Altı', color: 'bg-orange-100 text-orange-800' },
  poor: { label: 'Zayıf', color: 'bg-red-100 text-red-800' },
};

const growthStatusLabels: Record<string, { label: string; color: string }> = {
  ahead: { label: 'Hedefin Önünde', color: 'text-green-600' },
  on_track: { label: 'Hedefte', color: 'text-blue-600' },
  behind: { label: 'Hedefin Gerisinde', color: 'text-yellow-600' },
  critical: { label: 'Kritik', color: 'text-red-600' },
};

export const GrowthTab: React.FC = () => {
  const [activeView, setActiveView] = useState<'samples' | 'overview'>('overview');

  // Format date
  const formatDate = (date: Date): string => {
    return new Date(date).toLocaleDateString('tr-TR');
  };

  // Calculate growth percentage
  const getGrowthPercent = (current: number, initial: number): number => {
    return ((current - initial) / initial) * 100;
  };

  // Calculate target progress
  const getTargetProgress = (current: number, initial: number, target: number): number => {
    return ((current - initial) / (target - initial)) * 100;
  };

  return (
    <div className="space-y-6">
      {/* View Toggle */}
      <div className="flex items-center justify-between">
        <div className="flex space-x-4">
          <button
            onClick={() => setActiveView('overview')}
            className={`px-4 py-2 text-sm font-medium rounded-md ${
              activeView === 'overview'
                ? 'bg-blue-100 text-blue-700'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Büyüme Özeti
          </button>
          <button
            onClick={() => setActiveView('samples')}
            className={`px-4 py-2 text-sm font-medium rounded-md ${
              activeView === 'samples'
                ? 'bg-blue-100 text-blue-700'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Örneklemeler
          </button>
        </div>

        <button
          className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700"
        >
          <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Örnekleme Ekle
        </button>
      </div>

      {activeView === 'overview' ? (
        <>
          {/* Batch Growth Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {mockBatchGrowth.map((batch) => (
              <div key={batch.batchNumber} className="bg-white rounded-lg shadow-md overflow-hidden">
                {/* Header */}
                <div className="bg-gray-50 px-4 py-3 border-b border-gray-200">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-lg font-medium text-gray-900">{batch.batchNumber}</h3>
                      <p className="text-sm text-gray-500">{batch.speciesName}</p>
                    </div>
                    <span className={`text-sm font-medium ${growthStatusLabels[batch.growthStatus]?.color}`}>
                      {growthStatusLabels[batch.growthStatus]?.label}
                    </span>
                  </div>
                </div>

                {/* Body */}
                <div className="px-4 py-4">
                  {/* Metrics Grid */}
                  <div className="grid grid-cols-2 gap-4 mb-4">
                    <div>
                      <p className="text-xs text-gray-500">Mevcut Ağırlık</p>
                      <p className="text-lg font-semibold text-gray-900">{batch.currentWeight} g</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Hedef Ağırlık</p>
                      <p className="text-lg font-semibold text-gray-900">{batch.targetWeight} g</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">SGR</p>
                      <p className="text-lg font-semibold text-blue-600">{batch.sgr.toFixed(2)} %/gün</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">FCR</p>
                      <p className="text-lg font-semibold text-gray-900">{batch.fcr.toFixed(2)}</p>
                    </div>
                  </div>

                  {/* Progress Bar */}
                  <div className="mb-4">
                    <div className="flex justify-between text-xs text-gray-500 mb-1">
                      <span>Büyüme İlerlemesi</span>
                      <span>
                        {getTargetProgress(batch.currentWeight, batch.initialWeight, batch.targetWeight).toFixed(0)}%
                      </span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className="h-2 rounded-full bg-blue-500"
                        style={{
                          width: `${Math.min(
                            getTargetProgress(batch.currentWeight, batch.initialWeight, batch.targetWeight),
                            100
                          )}%`,
                        }}
                      />
                    </div>
                  </div>

                  {/* Growth Stats */}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-500">
                      Başlangıç: {batch.initialWeight} g
                    </span>
                    <span className="text-green-600 font-medium">
                      +{getGrowthPercent(batch.currentWeight, batch.initialWeight).toFixed(0)}%
                    </span>
                    <span className="text-gray-500">
                      {batch.daysInProduction} gün
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Growth Chart Placeholder */}
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Büyüme Grafiği</h3>
            <div className="h-64 flex items-center justify-center bg-gray-50 rounded-lg border-2 border-dashed border-gray-300">
              <div className="text-center">
                <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                <p className="mt-2 text-sm text-gray-500">
                  Büyüme grafiği API entegrasyonu sonrasında aktif olacak
                </p>
              </div>
            </div>
          </div>
        </>
      ) : (
        /* Samples View */
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Tarih
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Batch / Tank
                </th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Örnek
                </th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Ort. Ağırlık
                </th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Ort. Boy
                </th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  CV%
                </th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  SGR
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Performans
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {mockGrowthSamples.map((sample) => (
                <tr key={sample.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {formatDate(sample.measurementDate)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900">{sample.batchNumber}</div>
                    <div className="text-sm text-gray-500">{sample.tankName}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                    {sample.sampleSize}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                    {sample.avgWeight} g
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                    {sample.avgLength} cm
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right">
                    <span className={`text-sm font-medium ${sample.weightCV <= 15 ? 'text-green-600' : sample.weightCV <= 20 ? 'text-yellow-600' : 'text-red-600'}`}>
                      {sample.weightCV.toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-blue-600 font-medium text-right">
                    {sample.sgr.toFixed(2)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${performanceLabels[sample.performance]?.color}`}>
                      {performanceLabels[sample.performance]?.label}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default GrowthTab;
