/**
 * Tank Operations Tab
 * Tank cards/list with current batch status, operation buttons, and loss statistics charts
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { PieChart } from '@aquaculture/shared-ui';
import tankService from '../../../services/tank.service';
import {
  TankBatch,
  TankOperation,
  OperationType,
  MortalityReason,
  CullReason,
  ChartDataItem,
  LossStatistics,
  MortalityReasonLabels,
  CullReasonLabels,
  OperationTypeLabels,
  ChartColors,
  mockOperations,
} from '../types/batch.types';
import { MortalityModal } from '../components/MortalityModal';
import { CullModal } from '../components/CullModal';
import { TransferModal } from '../components/TransferModal';
import { HarvestModal } from '../components/HarvestModal';

// ============================================================================
// TYPES
// ============================================================================

type ViewMode = 'card' | 'list';
type ChartViewMode = 'byReason' | 'byTank';

// ============================================================================
// OPERATION COLORS
// ============================================================================

const operationColors: Record<OperationType, string> = {
  [OperationType.MORTALITY]: 'text-red-600',
  [OperationType.CULL]: 'text-orange-600',
  [OperationType.TRANSFER_OUT]: 'text-blue-600',
  [OperationType.TRANSFER_IN]: 'text-green-600',
  [OperationType.HARVEST]: 'text-purple-600',
  [OperationType.SAMPLING]: 'text-indigo-600',
  [OperationType.ADJUSTMENT]: 'text-gray-600',
};

// ============================================================================
// ICONS
// ============================================================================

const GridIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
  </svg>
);

const ListIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
  </svg>
);

// ============================================================================
// TANK CARD COMPONENT
// ============================================================================

interface TankCardProps {
  tankBatch: TankBatch;
  onMortality: () => void;
  onCull: () => void;
  onTransfer: () => void;
  onHarvest: () => void;
  onFeed: () => void;
  onSample: () => void;
}

const TankCard: React.FC<TankCardProps> = ({
  tankBatch,
  onMortality,
  onCull,
  onTransfer,
  onHarvest,
  onFeed,
  onSample,
}) => {
  const densityStatus = tankBatch.densityKgM3 > 20 ? 'high' : tankBatch.densityKgM3 > 15 ? 'medium' : 'low';
  const densityColor = densityStatus === 'high' ? 'text-red-600' : densityStatus === 'medium' ? 'text-yellow-600' : 'text-green-600';

  return (
    <div className="bg-white rounded-lg shadow-md overflow-hidden">
      {/* Header */}
      <div className="bg-gray-50 px-4 py-3 border-b border-gray-200">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-medium text-gray-900">{tankBatch.tankName}</h3>
          {tankBatch.isOverCapacity && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
              Over Capacity
            </span>
          )}
        </div>
        {tankBatch.primaryBatchNumber && (
          <p className="text-sm text-gray-500 mt-1">
            Batch: {tankBatch.primaryBatchNumber}
            {tankBatch.isMixedBatch && ' (Mixed)'}
          </p>
        )}
      </div>

      {/* Body */}
      <div className="px-4 py-4">
        {tankBatch.totalQuantity > 0 ? (
          <>
            {/* Metrics Grid */}
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <p className="text-xs text-gray-500">Stock</p>
                <p className="text-lg font-semibold text-gray-900">
                  {tankBatch.totalQuantity.toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Avg Weight</p>
                <p className="text-lg font-semibold text-gray-900">
                  {tankBatch.avgWeightG.toFixed(0)} g
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Biomass</p>
                <p className="text-lg font-semibold text-gray-900">
                  {tankBatch.totalBiomassKg.toLocaleString(undefined, { maximumFractionDigits: 0 })} kg
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Density</p>
                <p className={`text-lg font-semibold ${densityColor}`}>
                  {tankBatch.densityKgM3.toFixed(1)} kg/m³
                </p>
              </div>
            </div>

            {/* Capacity Bar */}
            {tankBatch.capacityUsedPercent !== undefined && (
              <div className="mb-4">
                <div className="flex justify-between text-xs text-gray-500 mb-1">
                  <span>Capacity Usage</span>
                  <span>{tankBatch.capacityUsedPercent.toFixed(0)}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full ${
                      tankBatch.capacityUsedPercent > 90 ? 'bg-red-500' :
                      tankBatch.capacityUsedPercent > 70 ? 'bg-yellow-500' : 'bg-green-500'
                    }`}
                    style={{ width: `${Math.min(tankBatch.capacityUsedPercent, 100)}%` }}
                  />
                </div>
              </div>
            )}

            {/* Operation Buttons */}
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={onFeed}
                className="flex flex-col items-center p-2 rounded-lg bg-green-50 hover:bg-green-100 text-green-700"
                title="Feed"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                </svg>
                <span className="text-xs mt-1">Feed</span>
              </button>

              <button
                onClick={onMortality}
                className="flex flex-col items-center p-2 rounded-lg bg-red-50 hover:bg-red-100 text-red-700"
                title="Record Mortality"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
                <span className="text-xs mt-1">Mortality</span>
              </button>

              <button
                onClick={onCull}
                className="flex flex-col items-center p-2 rounded-lg bg-orange-50 hover:bg-orange-100 text-orange-700"
                title="Cull"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                <span className="text-xs mt-1">Cull</span>
              </button>

              <button
                onClick={onTransfer}
                className="flex flex-col items-center p-2 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700"
                title="Transfer"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
                <span className="text-xs mt-1">Transfer</span>
              </button>

              <button
                onClick={onSample}
                className="flex flex-col items-center p-2 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700"
                title="Sample"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                <span className="text-xs mt-1">Sample</span>
              </button>

              <button
                onClick={onHarvest}
                className="flex flex-col items-center p-2 rounded-lg bg-purple-50 hover:bg-purple-100 text-purple-700"
                title="Harvest"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                </svg>
                <span className="text-xs mt-1">Harvest</span>
              </button>
            </div>
          </>
        ) : (
          <div className="text-center py-8">
            <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
            </svg>
            <p className="mt-2 text-sm text-gray-500">Tank empty</p>
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// LOSS STATISTICS CHARTS COMPONENT
// ============================================================================

interface LossStatisticsChartsProps {
  mortalityStats: LossStatistics;
  cullStats: LossStatistics;
  chartViewMode: ChartViewMode;
  onChartViewModeChange: (mode: ChartViewMode) => void;
}

const LossStatisticsCharts: React.FC<LossStatisticsChartsProps> = ({
  mortalityStats,
  cullStats,
  chartViewMode,
  onChartViewModeChange,
}) => {
  const mortalityData = chartViewMode === 'byReason' ? mortalityStats.byReason : mortalityStats.byTank;
  const cullData = chartViewMode === 'byReason' ? cullStats.byReason : cullStats.byTank;

  return (
    <div className="bg-white rounded-lg shadow p-6 mb-6">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-lg font-medium text-gray-900">Loss Statistics</h3>
        {/* Chart view toggle */}
        <div className="flex items-center gap-2 text-sm bg-gray-100 rounded-lg p-1">
          <button
            onClick={() => onChartViewModeChange('byReason')}
            className={`px-3 py-1.5 rounded-md transition-colors ${
              chartViewMode === 'byReason'
                ? 'bg-white text-blue-600 font-medium shadow-sm'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            By Reason
          </button>
          <button
            onClick={() => onChartViewModeChange('byTank')}
            className={`px-3 py-1.5 rounded-md transition-colors ${
              chartViewMode === 'byTank'
                ? 'bg-white text-blue-600 font-medium shadow-sm'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            By Tank
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Mortality Pie Chart */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-medium text-gray-600">Mortality</h4>
            <span className="text-sm text-gray-500">
              Total: {mortalityStats.total.toLocaleString()}
            </span>
          </div>
          {mortalityData.length > 0 ? (
            <PieChart
              data={mortalityData}
              size={180}
              innerRadius={40}
              showLegend
              showPercentages
            />
          ) : (
            <div className="flex items-center justify-center h-[180px] text-gray-400 text-sm">
              No mortality data
            </div>
          )}
        </div>

        {/* Cull Pie Chart */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-medium text-gray-600">Cull</h4>
            <span className="text-sm text-gray-500">
              Total: {cullStats.total.toLocaleString()}
            </span>
          </div>
          {cullData.length > 0 ? (
            <PieChart
              data={cullData}
              size={180}
              innerRadius={40}
              showLegend
              showPercentages
            />
          ) : (
            <div className="flex items-center justify-center h-[180px] text-gray-400 text-sm">
              No cull data
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// TANK LIST VIEW COMPONENT
// ============================================================================

interface TankListViewProps {
  tankBatches: TankBatch[];
  onOperation: (tank: TankBatch, operation: string) => void;
}

const TankListView: React.FC<TankListViewProps> = ({ tankBatches, onOperation }) => {
  const densityColor = (density: number) => {
    if (density > 20) return 'text-red-600';
    if (density > 15) return 'text-yellow-600';
    return 'text-green-600';
  };

  const capacityColor = (percent: number) => {
    if (percent > 90) return 'bg-red-100 text-red-800';
    if (percent > 70) return 'bg-yellow-100 text-yellow-800';
    return 'bg-green-100 text-green-800';
  };

  return (
    <div className="bg-white shadow rounded-lg overflow-hidden">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Tank
            </th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Batch
            </th>
            <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
              Stock
            </th>
            <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
              Avg Weight
            </th>
            <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
              Biomass
            </th>
            <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
              Density
            </th>
            <th scope="col" className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
              Capacity
            </th>
            <th scope="col" className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {tankBatches.map((tank) => (
            <tr key={tank.id} className="hover:bg-gray-50">
              <td className="px-6 py-4 whitespace-nowrap">
                <div className="flex items-center">
                  <div className="text-sm font-medium text-gray-900">{tank.tankName}</div>
                  {tank.isOverCapacity && (
                    <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
                      Over
                    </span>
                  )}
                </div>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {tank.primaryBatchNumber || '-'}
                {tank.isMixedBatch && <span className="ml-1 text-xs text-gray-400">(Mixed)</span>}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                {tank.totalQuantity.toLocaleString()}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                {tank.avgWeightG.toFixed(0)} g
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                {tank.totalBiomassKg.toLocaleString(undefined, { maximumFractionDigits: 0 })} kg
              </td>
              <td className={`px-6 py-4 whitespace-nowrap text-sm text-right font-medium ${densityColor(tank.densityKgM3)}`}>
                {tank.densityKgM3.toFixed(1)} kg/m³
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-center">
                {tank.capacityUsedPercent !== undefined && (
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${capacityColor(tank.capacityUsedPercent)}`}>
                    {tank.capacityUsedPercent.toFixed(0)}%
                  </span>
                )}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-center">
                <div className="flex items-center justify-center gap-1">
                  <button
                    onClick={() => onOperation(tank, 'feed')}
                    className="p-1.5 text-green-600 hover:bg-green-50 rounded"
                    title="Feed"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                    </svg>
                  </button>
                  <button
                    onClick={() => onOperation(tank, 'mortality')}
                    className="p-1.5 text-red-600 hover:bg-red-50 rounded"
                    title="Mortality"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                    </svg>
                  </button>
                  <button
                    onClick={() => onOperation(tank, 'cull')}
                    className="p-1.5 text-orange-600 hover:bg-orange-50 rounded"
                    title="Cull"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                  <button
                    onClick={() => onOperation(tank, 'transfer')}
                    className="p-1.5 text-blue-600 hover:bg-blue-50 rounded"
                    title="Transfer"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                  </button>
                  <button
                    onClick={() => onOperation(tank, 'harvest')}
                    className="p-1.5 text-purple-600 hover:bg-purple-50 rounded"
                    title="Harvest"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                    </svg>
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {tankBatches.length === 0 && (
        <div className="text-center py-12">
          <p className="text-sm text-gray-500">No tanks found</p>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export const TankOperationsTab: React.FC = () => {
  // View mode state
  const [viewMode, setViewMode] = useState<ViewMode>('card');
  const [chartViewMode, setChartViewMode] = useState<ChartViewMode>('byReason');

  // Data states - using mock data for now, will be replaced with API data
  const [tankBatches, setTankBatches] = useState<TankBatch[]>([]);
  const [operations, setOperations] = useState<TankOperation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal states
  const [showMortalityModal, setShowMortalityModal] = useState(false);
  const [showCullModal, setShowCullModal] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [showHarvestModal, setShowHarvestModal] = useState(false);
  const [selectedTank, setSelectedTank] = useState<TankBatch | null>(null);

  // Fetch data on mount
  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        // Fetch tanks from API and transform to TankBatch format
        const tanks = await tankService.listTanksAsBatches({ isActive: true });
        setTankBatches(tanks);

        // TODO: Fetch operations from API when backend endpoint is ready
        // For now, use mock operations for chart data
        setOperations(mockOperations);
      } catch (err) {
        console.error('Failed to fetch tanks:', err);
        setError(err instanceof Error ? err.message : 'Failed to load tanks');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  // Calculate chart statistics from operations
  const chartStats = useMemo(() => {
    // Mortality by reason
    const mortalityByReason: Record<string, number> = {};
    const mortalityByTank: Record<string, number> = {};
    let totalMortality = 0;

    // Cull by reason
    const cullByReason: Record<string, number> = {};
    const cullByTank: Record<string, number> = {};
    let totalCull = 0;

    operations.forEach((op) => {
      if (op.operationType === OperationType.MORTALITY) {
        const reason = op.mortalityReason || MortalityReason.UNKNOWN;
        const reasonLabel = MortalityReasonLabels[reason] || 'Unknown';
        mortalityByReason[reasonLabel] = (mortalityByReason[reasonLabel] || 0) + op.quantity;

        const tankName = op.tankName || 'Unknown';
        mortalityByTank[tankName] = (mortalityByTank[tankName] || 0) + op.quantity;

        totalMortality += op.quantity;
      }

      if (op.operationType === OperationType.CULL) {
        const reason = op.cullReason || CullReason.OTHER;
        const reasonLabel = CullReasonLabels[reason] || 'Other';
        cullByReason[reasonLabel] = (cullByReason[reasonLabel] || 0) + op.quantity;

        const tankName = op.tankName || 'Unknown';
        cullByTank[tankName] = (cullByTank[tankName] || 0) + op.quantity;

        totalCull += op.quantity;
      }
    });

    // Convert to chart data format
    const mortalityReasonData: ChartDataItem[] = Object.entries(mortalityByReason).map(
      ([label, value], index) => ({
        label,
        value,
        color: Object.values(ChartColors.mortality)[index % Object.values(ChartColors.mortality).length],
      })
    );

    const mortalityTankData: ChartDataItem[] = Object.entries(mortalityByTank).map(
      ([label, value], index) => ({
        label,
        value,
        color: ChartColors.tanks[index % ChartColors.tanks.length],
      })
    );

    const cullReasonData: ChartDataItem[] = Object.entries(cullByReason).map(
      ([label, value], index) => ({
        label,
        value,
        color: Object.values(ChartColors.cull)[index % Object.values(ChartColors.cull).length],
      })
    );

    const cullTankData: ChartDataItem[] = Object.entries(cullByTank).map(
      ([label, value], index) => ({
        label,
        value,
        color: ChartColors.tanks[index % ChartColors.tanks.length],
      })
    );

    return {
      mortality: {
        byReason: mortalityReasonData,
        byTank: mortalityTankData,
        total: totalMortality,
      },
      cull: {
        byReason: cullReasonData,
        byTank: cullTankData,
        total: totalCull,
      },
    };
  }, [operations]);

  // Handle operation click
  const handleOperation = useCallback((tank: TankBatch, operation: string) => {
    setSelectedTank(tank);
    switch (operation) {
      case 'mortality':
        setShowMortalityModal(true);
        break;
      case 'cull':
        setShowCullModal(true);
        break;
      case 'transfer':
        setShowTransferModal(true);
        break;
      case 'harvest':
        setShowHarvestModal(true);
        break;
      case 'feed':
        // TODO: Implement feed modal
        break;
      case 'sample':
        // TODO: Implement sample modal
        break;
    }
  }, []);

  // Format date
  const formatDate = (date: Date): string => {
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex items-center gap-3 text-gray-500">
          <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span>Loading tanks...</span>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
        <div className="flex items-center gap-2">
          <svg className="h-5 w-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>Error loading tanks: {error}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Loss Statistics Charts */}
      <LossStatisticsCharts
        mortalityStats={chartStats.mortality}
        cullStats={chartStats.cull}
        chartViewMode={chartViewMode}
        onChartViewModeChange={setChartViewMode}
      />

      {/* Header with View Toggle */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium text-gray-900">
          Tanks ({tankBatches.length})
        </h2>
        <div className="flex items-center gap-2 bg-gray-100 rounded-lg p-1">
          <button
            onClick={() => setViewMode('card')}
            className={`p-2 rounded-md transition-colors ${
              viewMode === 'card'
                ? 'bg-white text-blue-600 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
            title="Card view"
          >
            <GridIcon className="w-5 h-5" />
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={`p-2 rounded-md transition-colors ${
              viewMode === 'list'
                ? 'bg-white text-blue-600 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
            title="List view"
          >
            <ListIcon className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Tank Cards/List */}
      {tankBatches.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-12 text-center">
          <svg className="mx-auto h-16 w-16 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
          </svg>
          <h3 className="mt-4 text-lg font-medium text-gray-900">No Tanks Found</h3>
          <p className="mt-2 text-sm text-gray-500">
            No tanks have been added to this facility yet.<br />
            Add tanks in the Equipment section to see them here.
          </p>
        </div>
      ) : viewMode === 'card' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {tankBatches.map((tank) => (
            <TankCard
              key={tank.id}
              tankBatch={tank}
              onMortality={() => handleOperation(tank, 'mortality')}
              onCull={() => handleOperation(tank, 'cull')}
              onTransfer={() => handleOperation(tank, 'transfer')}
              onHarvest={() => handleOperation(tank, 'harvest')}
              onFeed={() => handleOperation(tank, 'feed')}
              onSample={() => handleOperation(tank, 'sample')}
            />
          ))}
        </div>
      ) : (
        <TankListView
          tankBatches={tankBatches}
          onOperation={handleOperation}
        />
      )}

      {/* Recent Operations */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 border-b border-gray-200 sm:px-6">
          <h3 className="text-lg leading-6 font-medium text-gray-900">
            Recent Operations
          </h3>
        </div>
        <div className="overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Date
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Tank
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Batch
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Operation
                </th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Quantity
                </th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Biomass
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {operations.slice(0, 10).map((op) => (
                <tr key={op.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {formatDate(op.operationDate)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {op.tankName}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {op.batchNumber}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`text-sm font-medium ${operationColors[op.operationType]}`}>
                      {OperationTypeLabels[op.operationType]}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                    {op.quantity.toLocaleString()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 text-right">
                    {op.biomassKg?.toFixed(1)} kg
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {operations.length === 0 && (
            <div className="text-center py-12">
              <p className="text-sm text-gray-500">No operations recorded yet</p>
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      {showMortalityModal && selectedTank && (
        <MortalityModal
          isOpen={showMortalityModal}
          onClose={() => {
            setShowMortalityModal(false);
            setSelectedTank(null);
          }}
          tank={selectedTank}
          onSuccess={async () => {
            // Refresh tank data
            try {
              const tanks = await tankService.listTanksAsBatches({ isActive: true });
              setTankBatches(tanks);
            } catch (err) {
              console.error('Failed to refresh tanks:', err);
            }
          }}
        />
      )}

      {showCullModal && selectedTank && (
        <CullModal
          isOpen={showCullModal}
          onClose={() => {
            setShowCullModal(false);
            setSelectedTank(null);
          }}
          tank={selectedTank}
          onSuccess={async () => {
            // Refresh tank data
            try {
              const tanks = await tankService.listTanksAsBatches({ isActive: true });
              setTankBatches(tanks);
            } catch (err) {
              console.error('Failed to refresh tanks:', err);
            }
          }}
        />
      )}

      {showTransferModal && selectedTank && (
        <TransferModal
          isOpen={showTransferModal}
          onClose={() => {
            setShowTransferModal(false);
            setSelectedTank(null);
          }}
          tank={selectedTank}
          onSuccess={async () => {
            // Refresh tank data
            try {
              const tanks = await tankService.listTanksAsBatches({ isActive: true });
              setTankBatches(tanks);
            } catch (err) {
              console.error('Failed to refresh tanks:', err);
            }
          }}
        />
      )}

      {showHarvestModal && selectedTank && (
        <HarvestModal
          isOpen={showHarvestModal}
          onClose={() => {
            setShowHarvestModal(false);
            setSelectedTank(null);
          }}
          tank={selectedTank}
          onSuccess={async () => {
            // Refresh tank data
            try {
              const tanks = await tankService.listTanksAsBatches({ isActive: true });
              setTankBatches(tanks);
            } catch (err) {
              console.error('Failed to refresh tanks:', err);
            }
          }}
        />
      )}
    </div>
  );
};

export default TankOperationsTab;
