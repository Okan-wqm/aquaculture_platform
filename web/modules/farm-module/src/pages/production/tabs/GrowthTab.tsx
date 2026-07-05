/**
 * Growth Tab
 * Growth samples and metrics tracking - connected to backend API
 */
import React, { useState, useMemo } from 'react';
import {
  useGrowthMeasurements,
  useGrowthAnalysis,
  useBatchGrowthHistory,
  type GrowthAnalysis,
} from '../../../hooks/useGrowth';
import { useBatchList } from '../../../hooks/useBatches';

// ============================================================================
// CONSTANTS
// ============================================================================

const performanceLabels: Record<string, { label: string; color: string }> = {
  excellent: { label: 'Mukemmel', color: 'bg-green-100 text-green-800' },
  good: { label: 'Iyi', color: 'bg-blue-100 text-blue-800' },
  average: { label: 'Orta', color: 'bg-yellow-100 text-yellow-800' },
  below_average: { label: 'Ortalamanin Alti', color: 'bg-orange-100 text-orange-800' },
  poor: { label: 'Zayif', color: 'bg-red-100 text-red-800' },
};

const growthStatusLabels: Record<string, { label: string; color: string }> = {
  ahead: { label: 'Hedefin Onunde', color: 'text-green-600' },
  on_track: { label: 'Hedefte', color: 'text-blue-600' },
  behind: { label: 'Hedefin Gerisinde', color: 'text-yellow-600' },
  critical: { label: 'Kritik', color: 'text-red-600' },
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function formatDate(date: string | Date): string {
  return new Date(date).toLocaleDateString('tr-TR');
}

function getTargetProgress(current: number, initial: number, target: number): number {
  if (target <= initial) return 100;
  return ((current - initial) / (target - initial)) * 100;
}

function getGrowthStatus(variancePercent: number): string {
  if (variancePercent > 10) return 'ahead';
  if (variancePercent >= -5) return 'on_track';
  if (variancePercent >= -15) return 'behind';
  return 'critical';
}

// ============================================================================
// LOADING / ERROR / EMPTY COMPONENTS
// ============================================================================

const LoadingSpinner: React.FC = () => (
  <div className="flex items-center justify-center py-12">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
    <span className="ml-3 text-gray-500">Yukleniyor...</span>
  </div>
);

const ErrorMessage: React.FC<{ message: string }> = ({ message }) => (
  <div className="bg-red-50 border border-red-200 rounded-lg p-4">
    <p className="text-sm text-red-700">{message}</p>
  </div>
);

const EmptyState: React.FC<{ message: string }> = ({ message }) => (
  <div className="bg-white rounded-lg shadow p-12 text-center">
    <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
    <p className="mt-2 text-sm text-gray-500">{message}</p>
  </div>
);

// ============================================================================
// BATCH ANALYSIS CARD
// ============================================================================

const BatchAnalysisCard: React.FC<{ analysis: GrowthAnalysis }> = ({ analysis }) => {
  const metrics = analysis.currentMetrics;
  const growthStatus = getGrowthStatus(metrics.weightVariancePercent);
  const statusInfo = growthStatusLabels[growthStatus];

  return (
    <div className="bg-white rounded-lg shadow-md overflow-hidden">
      {/* Header */}
      <div className="bg-gray-50 px-4 py-3 border-b border-gray-200">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-medium text-gray-900">{analysis.batchCode}</h3>
            <p className="text-sm text-gray-500">{analysis.speciesName}</p>
          </div>
          <span className={`text-sm font-medium ${statusInfo?.color ?? 'text-gray-600'}`}>
            {statusInfo?.label ?? 'Bilinmiyor'}
          </span>
        </div>
      </div>

      {/* Body */}
      <div className="px-4 py-4">
        {/* Metrics Grid */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <p className="text-xs text-gray-500">Mevcut Agirlik</p>
            <p className="text-lg font-semibold text-gray-900">{metrics.currentAvgWeightG.toFixed(1)} g</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Teorik Agirlik</p>
            <p className="text-lg font-semibold text-gray-900">{metrics.theoreticalWeightG.toFixed(1)} g</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">SGR</p>
            <p className="text-lg font-semibold text-blue-600">{metrics.specificGrowthRate.toFixed(2)} %/gun</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">FCR</p>
            <p className="text-lg font-semibold text-gray-900">{metrics.currentFCR.toFixed(2)}</p>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="mb-4">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>Buyume Ilerlemesi</span>
            <span>
              {analysis.projection.daysToHarvest > 0
                ? `Hasata ${analysis.projection.daysToHarvest} gun`
                : 'Hasat hazir'}
            </span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="h-2 rounded-full bg-blue-500"
              style={{
                width: `${Math.min(
                  getTargetProgress(
                    metrics.currentAvgWeightG,
                    0,
                    analysis.projection.harvestTargetWeightG
                  ),
                  100
                )}%`,
              }}
            />
          </div>
        </div>

        {/* Additional Stats */}
        <div className="grid grid-cols-3 gap-2 text-sm">
          <div className="text-center">
            <p className="text-xs text-gray-500">Biomass</p>
            <p className="font-medium">{metrics.currentBiomassKg.toFixed(0)} kg</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-gray-500">Yasama Orani</p>
            <p className="font-medium text-green-600">{metrics.survivalRate.toFixed(1)}%</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-gray-500">Uretimde</p>
            <p className="font-medium">{analysis.daysInProduction} gun</p>
          </div>
        </div>

        {/* Recommendations */}
        {analysis.recommendations.length > 0 && (
          <div className="mt-4 border-t pt-3">
            <p className="text-xs text-gray-500 mb-2">Oneriler</p>
            {analysis.recommendations.slice(0, 2).map((rec, idx) => (
              <div key={idx} className={`text-xs mb-1 px-2 py-1 rounded ${
                rec.priority === 'high' ? 'bg-red-50 text-red-700' :
                rec.priority === 'medium' ? 'bg-yellow-50 text-yellow-700' :
                'bg-gray-50 text-gray-700'
              }`}>
                {rec.description}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// GROWTH CHART PLACEHOLDER (uses measurement history)
// ============================================================================

const GrowthChart: React.FC<{ batchId: string }> = ({ batchId }) => {
  const { data: history, isLoading } = useBatchGrowthHistory(batchId, 20);

  if (isLoading) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Buyume Gecmisi</h3>
        <LoadingSpinner />
      </div>
    );
  }

  if (!history || history.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Buyume Gecmisi</h3>
        <EmptyState message="Henuz olcum verisi yok" />
      </div>
    );
  }

  // Sort by date ascending for the chart
  const sortedHistory = [...history].sort(
    (a, b) => new Date(a.measurementDate).getTime() - new Date(b.measurementDate).getTime()
  );

  const maxWeight = Math.max(...sortedHistory.map(m => m.averageWeight));

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-lg font-medium text-gray-900 mb-4">Buyume Gecmisi</h3>

      {/* Simple bar chart visualization */}
      <div className="h-48 flex items-end space-x-1">
        {sortedHistory.map((m) => {
          const heightPercent = maxWeight > 0 ? (m.averageWeight / maxWeight) * 100 : 0;
          return (
            <div
              key={m.id}
              className="flex-1 flex flex-col items-center group relative"
            >
              {/* Tooltip */}
              <div className="invisible group-hover:visible absolute bottom-full mb-2 bg-gray-800 text-white text-xs rounded px-2 py-1 whitespace-nowrap z-10">
                {formatDate(m.measurementDate)}: {m.averageWeight.toFixed(1)}g
              </div>
              <div
                className={`w-full rounded-t ${
                  m.performance === 'excellent' || m.performance === 'good'
                    ? 'bg-blue-400'
                    : m.performance === 'average'
                    ? 'bg-yellow-400'
                    : 'bg-red-400'
                }`}
                style={{ height: `${heightPercent}%`, minHeight: '4px' }}
              />
            </div>
          );
        })}
      </div>

      {/* X-axis labels */}
      <div className="flex justify-between text-xs text-gray-400 mt-2">
        <span>{sortedHistory.length > 0 ? formatDate(sortedHistory[0]!.measurementDate) : ''}</span>
        <span>{sortedHistory.length > 0 ? formatDate(sortedHistory[sortedHistory.length - 1]!.measurementDate) : ''}</span>
      </div>

      {/* Summary row */}
      <div className="mt-4 grid grid-cols-4 gap-4 text-center text-sm border-t pt-3">
        <div>
          <p className="text-xs text-gray-500">Toplam Olcum</p>
          <p className="font-medium">{sortedHistory.length}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Ilk Agirlik</p>
          <p className="font-medium">{sortedHistory[0]?.averageWeight.toFixed(1)} g</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Son Agirlik</p>
          <p className="font-medium">{sortedHistory[sortedHistory.length - 1]?.averageWeight.toFixed(1)} g</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Artis</p>
          <p className="font-medium text-green-600">
            +{(
              (sortedHistory[sortedHistory.length - 1]?.averageWeight ?? 0) -
              (sortedHistory[0]?.averageWeight ?? 0)
            ).toFixed(1)} g
          </p>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export const GrowthTab: React.FC = () => {
  const [activeView, setActiveView] = useState<'samples' | 'overview'>('overview');
  const [selectedBatchId, setSelectedBatchId] = useState<string>('');

  // Fetch active batches for batch selection
  const { data: batchData, isLoading: batchesLoading } = useBatchList(
    { isActive: true },
    { fetchAll: true, sortBy: 'stockedAt', sortOrder: 'DESC' }
  );

  const activeBatches = batchData?.items ?? [];

  // Fetch growth measurements (all or filtered by batch)
  const measurementFilter = useMemo(
    () => (selectedBatchId ? { batchId: selectedBatchId } : undefined),
    [selectedBatchId]
  );
  const measurementPagination = useMemo(() => ({ limit: 50 }), []);

  const {
    data: measurementsData,
    isLoading: measurementsLoading,
    error: measurementsError,
  } = useGrowthMeasurements(measurementFilter, measurementPagination);

  // Fetch growth analysis for selected batch
  const {
    data: analysisData,
    isLoading: analysisLoading,
    error: analysisError,
  } = useGrowthAnalysis(selectedBatchId, { enabled: !!selectedBatchId });

  const measurements = measurementsData?.items ?? [];

  return (
    <div className="space-y-6">
      {/* View Toggle + Batch Selector */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex space-x-4">
          <button
            onClick={() => setActiveView('overview')}
            className={`px-4 py-2 text-sm font-medium rounded-md ${
              activeView === 'overview'
                ? 'bg-blue-100 text-blue-700'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Buyume Ozeti
          </button>
          <button
            onClick={() => setActiveView('samples')}
            className={`px-4 py-2 text-sm font-medium rounded-md ${
              activeView === 'samples'
                ? 'bg-blue-100 text-blue-700'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Orneklemeler
          </button>
        </div>

        <div className="flex items-center gap-3">
          {/* Batch Filter */}
          <select
            value={selectedBatchId}
            onChange={(e) => setSelectedBatchId(e.target.value)}
            className="block w-48 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
          >
            <option value="">Tum Batch'ler</option>
            {activeBatches.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batch.batchNumber}
              </option>
            ))}
          </select>

          <button
            className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700"
          >
            <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Ornekleme Ekle
          </button>
        </div>
      </div>

      {activeView === 'overview' ? (
        <>
          {/* Analysis Cards */}
          {selectedBatchId ? (
            // Single batch analysis
            analysisLoading ? (
              <LoadingSpinner />
            ) : analysisError ? (
              <ErrorMessage message={`Analiz yuklenemedi: ${analysisError instanceof Error ? analysisError.message : 'Bilinmeyen hata'}`} />
            ) : analysisData ? (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <BatchAnalysisCard analysis={analysisData} />

                  {/* Trend Card */}
                  <div className="bg-white rounded-lg shadow-md p-4">
                    <h3 className="text-lg font-medium text-gray-900 mb-4">Trend Analizi</h3>
                    <div className="space-y-4">
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-gray-500">Yonelim</span>
                        <span className={`text-sm font-medium ${
                          analysisData.trend.direction === 'improving' ? 'text-green-600' :
                          analysisData.trend.direction === 'stable' ? 'text-blue-600' :
                          'text-red-600'
                        }`}>
                          {analysisData.trend.direction === 'improving' ? 'Yukseliyor' :
                           analysisData.trend.direction === 'stable' ? 'Stabil' : 'Dusuyor'}
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-gray-500">Son 7 Gun ADG</span>
                        <span className="text-sm font-medium">{analysisData.trend.avgDailyGrowthLast7Days.toFixed(2)} g/gun</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-gray-500">Son 30 Gun ADG</span>
                        <span className="text-sm font-medium">{analysisData.trend.avgDailyGrowthLast30Days.toFixed(2)} g/gun</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-gray-500">FCR Trendi</span>
                        <span className={`text-sm font-medium ${
                          analysisData.trend.fcrTrend === 'improving' ? 'text-green-600' :
                          analysisData.trend.fcrTrend === 'stable' ? 'text-blue-600' :
                          'text-red-600'
                        }`}>
                          {analysisData.trend.fcrTrend === 'improving' ? 'Iyilesiyor' :
                           analysisData.trend.fcrTrend === 'stable' ? 'Stabil' : 'Kotulesiyor'}
                        </span>
                      </div>

                      {/* Projection */}
                      <div className="border-t pt-3 mt-3">
                        <h4 className="text-sm font-medium text-gray-700 mb-2">Projeksiyon</h4>
                        <div className="space-y-2">
                          <div className="flex justify-between items-center">
                            <span className="text-xs text-gray-500">30 Gun Sonra Agirlik</span>
                            <span className="text-xs font-medium">{analysisData.projection.projectedWeightIn30Days.toFixed(1)} g</span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-xs text-gray-500">Tahmini Hasat Tarihi</span>
                            <span className="text-xs font-medium">{formatDate(analysisData.projection.estimatedHarvestDate)}</span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-xs text-gray-500">Hasata Kalan Gun</span>
                            <span className="text-xs font-medium">{analysisData.projection.daysToHarvest} gun</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Growth Chart */}
                <GrowthChart batchId={selectedBatchId} />
              </div>
            ) : (
              <EmptyState message="Bu batch icin analiz verisi bulunamadi" />
            )
          ) : (
            // All batches overview - show analysis cards for each active batch
            batchesLoading ? (
              <LoadingSpinner />
            ) : activeBatches.length === 0 ? (
              <EmptyState message="Aktif batch bulunamadi" />
            ) : (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {activeBatches.slice(0, 6).map((batch) => (
                    <BatchAnalysisCardWrapper key={batch.id} batchId={batch.id} />
                  ))}
                </div>
                {activeBatches.length > 6 && (
                  <p className="text-center text-sm text-gray-500">
                    +{activeBatches.length - 6} daha fazla batch. Filtrelemek icin batch secin.
                  </p>
                )}
              </div>
            )
          )}
        </>
      ) : (
        /* Samples View */
        measurementsLoading ? (
          <LoadingSpinner />
        ) : measurementsError ? (
          <ErrorMessage message={`Olcumler yuklenemedi: ${measurementsError instanceof Error ? measurementsError.message : 'Bilinmeyen hata'}`} />
        ) : measurements.length === 0 ? (
          <EmptyState message="Henuz buyume olcumu bulunmuyor" />
        ) : (
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
                    Ornek
                  </th>
                  <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Ort. Agirlik
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
                  <th scope="col" className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Dogrulandi
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {measurements.map((sample) => (
                  <tr key={sample.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {formatDate(sample.measurementDate)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900">{sample.batchId.substring(0, 8)}...</div>
                      <div className="text-sm text-gray-500">{sample.tankId ? `Tank: ${sample.tankId.substring(0, 8)}...` : '-'}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                      {sample.sampleSize}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                      {sample.averageWeight.toFixed(1)} g
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                      {sample.averageLength != null ? `${sample.averageLength.toFixed(1)} cm` : '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <span className={`text-sm font-medium ${sample.weightCV <= 15 ? 'text-green-600' : sample.weightCV <= 20 ? 'text-yellow-600' : 'text-red-600'}`}>
                        {sample.weightCV.toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-blue-600 font-medium text-right">
                      {sample.specificGrowthRate != null ? sample.specificGrowthRate.toFixed(2) : '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {sample.performance ? (
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${performanceLabels[sample.performance]?.color ?? 'bg-gray-100 text-gray-800'}`}>
                          {performanceLabels[sample.performance]?.label ?? sample.performance}
                        </span>
                      ) : (
                        <span className="text-sm text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-center">
                      {sample.isVerified ? (
                        <svg className="h-5 w-5 text-green-500 inline" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                      ) : (
                        <svg className="h-5 w-5 text-gray-300 inline" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm0-2a6 6 0 100-12 6 6 0 000 12z" clipRule="evenodd" />
                        </svg>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Pagination info */}
            {measurementsData && (
              <div className="px-6 py-3 border-t border-gray-200 flex items-center justify-between bg-gray-50">
                <p className="text-sm text-gray-500">
                  Toplam {measurementsData.total} olcum
                </p>
                {measurementsData.hasNextPage && (
                  <p className="text-sm text-gray-500">
                    Daha fazla olcum mevcut
                  </p>
                )}
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
};

// ============================================================================
// BATCH ANALYSIS CARD WRAPPER (fetches analysis for individual batch)
// ============================================================================

const BatchAnalysisCardWrapper: React.FC<{ batchId: string }> = ({ batchId }) => {
  const { data: analysis, isLoading, error } = useGrowthAnalysis(batchId);

  if (isLoading) {
    return (
      <div className="bg-white rounded-lg shadow-md p-6">
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-gray-200 rounded w-1/3" />
          <div className="h-3 bg-gray-200 rounded w-1/4" />
          <div className="grid grid-cols-2 gap-4 mt-4">
            <div className="h-12 bg-gray-200 rounded" />
            <div className="h-12 bg-gray-200 rounded" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !analysis) {
    return (
      <div className="bg-white rounded-lg shadow-md p-6 text-center text-sm text-gray-400">
        Analiz verisi yuklenemedi
      </div>
    );
  }

  return <BatchAnalysisCard analysis={analysis} />;
};

export default GrowthTab;
