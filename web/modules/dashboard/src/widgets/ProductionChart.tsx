/**
 * Production Chart Widget
 *
 * Displays production trend data using real harvest statistics from farm-service.
 * Uses harvestStatistics GraphQL query for monthly aggregation.
 */

import React, { useMemo } from 'react';
import { Card } from '@aquaculture/shared-ui';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
// PERF-L4: shared icon components -- eliminates duplicate inline SVG bytes
import { TrendUpIcon } from '../components/icons';
import { useHarvestStatistics } from '../hooks/useDashboardData';

export interface ProductionChartProps {
  farmId?: string;
  period?: '7days' | '30days' | '90days';
  className?: string;
}

// Month labels (Turkish abbreviations)
const MONTH_LABELS = [
  '', 'Oca', 'Sub', 'Mar', 'Nis', 'May', 'Haz',
  'Tem', 'Agu', 'Eyl', 'Eki', 'Kas', 'Ara',
];

// PERF-M1: tooltip style hoisted to module scope
const tooltipStyle = {
  backgroundColor: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
};

export const ProductionChart: React.FC<ProductionChartProps> = ({
  farmId,
  period = '30days',
  className = '',
}) => {
  const harvestQuery = useHarvestStatistics(period);

  // Transform harvest data into chart format
  const chartData = useMemo(() => {
    if (!harvestQuery.data?.byMonth) return [];

    return harvestQuery.data.byMonth
      .sort((a, b) => a.year - b.year || a.month - b.month)
      .map((item) => ({
        month: MONTH_LABELS[item.month] || `${item.month}`,
        uretim: Math.round((item.totalBiomass / 1000) * 10) / 10, // kg -> ton
        hasat: item.count,
      }));
  }, [harvestQuery.data?.byMonth]);

  // Summary stats
  const summary = harvestQuery.data?.summary;
  const totalTons = summary ? (summary.totalBiomassKg / 1000).toFixed(1) : '0';
  const totalHarvests = summary?.totalHarvests ?? 0;

  // Loading state
  if (harvestQuery.isLoading) {
    return (
      <Card className={`p-4 ${className}`}>
        <div className="animate-pulse">
          <div className="h-4 bg-gray-200 rounded w-1/3 mb-2" />
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-4" />
          <div className="h-32 bg-gray-200 rounded" />
        </div>
      </Card>
    );
  }

  // Error state
  if (harvestQuery.isError) {
    return (
      <Card className={`p-4 ${className}`}>
        <div className="text-center py-6 text-gray-500">
          <TrendUpIcon className="w-8 h-8 mx-auto mb-2 text-red-400" />
          <p className="text-sm font-medium text-red-500">Uretim verileri yuklenemedi</p>
          <button
            type="button"
            onClick={() => harvestQuery.refetch()}
            className="text-xs text-primary-600 font-medium hover:underline mt-2"
          >
            Tekrar Dene
          </button>
        </div>
      </Card>
    );
  }

  // Empty state
  if (chartData.length === 0) {
    return (
      <Card className={`p-4 ${className}`}>
        <div className="text-center py-6 text-gray-500">
          <TrendUpIcon className="w-8 h-8 mx-auto mb-2" />
          <p className="text-sm font-medium">Uretim Grafigi</p>
          {farmId && <p className="text-xs mt-1">Ciftlik: {farmId.slice(0, 8)}</p>}
          <p className="text-xs mt-1">Donem: {period}</p>
          <p className="text-xs mt-2">Secilen donemde hasat verisi bulunamadi</p>
        </div>
      </Card>
    );
  }

  return (
    <Card className={`p-4 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Uretim Grafigi</h3>
          <p className="text-2xl font-bold text-gray-900">{totalTons} Ton</p>
          <p className="text-xs text-gray-500">{totalHarvests} hasat</p>
        </div>
        <TrendUpIcon className="w-6 h-6 text-primary-600" />
      </div>

      <ResponsiveContainer width="100%" height={120}>
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
          <XAxis dataKey="month" tick={{ fontSize: 10 }} stroke="#6b7280" />
          <YAxis hide />
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(value: number) => [`${value} Ton`, 'Uretim']}
          />
          <Bar
            dataKey="uretim"
            fill="#0073e6"
            radius={[2, 2, 0, 0]}
            maxBarSize={24}
          />
        </BarChart>
      </ResponsiveContainer>
    </Card>
  );
};

export default ProductionChart;
