/**
 * Chart Settings Modal Component
 * Modal for selecting which charts and tanks to display
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Modal } from '@aquaculture/shared-ui';
import type { TankWithBatch } from '../types';
import type { ChartVisibility } from './TankChartsSection';

// Chart definitions for the settings UI
const PIE_CHARTS = [
  { key: 'categoryDistribution', label: 'Category Distribution' },
  { key: 'biomassByTank', label: 'Biomass by Tank' },
  { key: 'fishCountByTank', label: 'Fish Count by Tank' },
  { key: 'densityUsage', label: 'Density Usage' },
  { key: 'speciesBiomass', label: 'Species Biomass %' },
  { key: 'mortalityByTank', label: 'Mortality by Tank' },
  { key: 'cullByTank', label: 'Cull by Tank' },
  { key: 'biomassBySpecies', label: 'Biomass by Species' },
] as const;

const LINE_CHARTS = [
  { key: 'mortalityTrend', label: 'Mortality Trend' },
  { key: 'growthTrend', label: 'Growth Trend' },
  { key: 'biomassTrend', label: 'Biomass Trend' },
  { key: 'fcrTrend', label: 'FCR Trend' },
  { key: 'feedTrend', label: 'Feed Trend' },
  { key: 'densityTrend', label: 'Density Trend' },
  { key: 'fishCountTrend', label: 'Fish Count Trend' },
  { key: 'sgrTrend', label: 'SGR Trend' },
] as const;

interface ChartSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  tanks: TankWithBatch[];
  selectedTankIds: string[];
  onSelectionChange: (ids: string[]) => void;
  timeRange: '7d' | '30d' | '90d';
  onTimeRangeChange: (range: '7d' | '30d' | '90d') => void;
  chartVisibility: ChartVisibility;
  onChartVisibilityChange: (visibility: ChartVisibility) => void;
}

export const ChartSettingsModal: React.FC<ChartSettingsModalProps> = ({
  isOpen,
  onClose,
  tanks,
  selectedTankIds,
  onSelectionChange,
  timeRange,
  onTimeRangeChange,
  chartVisibility,
  onChartVisibilityChange,
}) => {
  // Local state for edits before applying
  const [localSelectedIds, setLocalSelectedIds] = useState<string[]>(selectedTankIds);
  const [localTimeRange, setLocalTimeRange] = useState<'7d' | '30d' | '90d'>(timeRange);
  const [localChartVisibility, setLocalChartVisibility] = useState<ChartVisibility>(chartVisibility);

  // Reset local state when modal opens
  useEffect(() => {
    if (isOpen) {
      setLocalSelectedIds(selectedTankIds);
      setLocalTimeRange(timeRange);
      setLocalChartVisibility(chartVisibility);
    }
  }, [isOpen, selectedTankIds, timeRange, chartVisibility]);

  // Group tanks by category
  const groupedTanks = useMemo(() => {
    const groups: Record<string, TankWithBatch[]> = {
      TANK: [],
      POND: [],
      CAGE: [],
    };

    tanks.forEach(tank => {
      const category = tank.category.toUpperCase();
      if (groups[category]) {
        groups[category].push(tank);
      }
    });

    return groups;
  }, [tanks]);

  // Check if all are selected
  const allSelected = localSelectedIds.length === tanks.length;
  const someSelected = localSelectedIds.length > 0 && localSelectedIds.length < tanks.length;

  // Handlers
  const handleSelectAll = () => {
    if (allSelected) {
      setLocalSelectedIds([]);
    } else {
      setLocalSelectedIds(tanks.map(t => t.id));
    }
  };

  const handleToggleTank = (tankId: string) => {
    setLocalSelectedIds(prev => {
      if (prev.includes(tankId)) {
        return prev.filter(id => id !== tankId);
      }
      return [...prev, tankId];
    });
  };

  const handleSelectCategory = (category: string, select: boolean) => {
    const categoryTankIds = groupedTanks[category]?.map(t => t.id) || [];
    if (select) {
      setLocalSelectedIds(prev => [...new Set([...prev, ...categoryTankIds])]);
    } else {
      setLocalSelectedIds(prev => prev.filter(id => !categoryTankIds.includes(id)));
    }
  };

  const handleToggleChart = (chartKey: keyof ChartVisibility) => {
    setLocalChartVisibility(prev => ({
      ...prev,
      [chartKey]: !prev[chartKey],
    }));
  };

  const handleApply = () => {
    onSelectionChange(localSelectedIds);
    onTimeRangeChange(localTimeRange);
    onChartVisibilityChange(localChartVisibility);
    onClose();
  };

  const getCategoryColor = (category: string): string => {
    switch (category) {
      case 'TANK': return 'text-cyan-600';
      case 'POND': return 'text-blue-600';
      case 'CAGE': return 'text-purple-600';
      default: return 'text-gray-600';
    }
  };

  const getCategoryBadgeColor = (category: string): string => {
    switch (category) {
      case 'TANK': return 'bg-cyan-100 text-cyan-700';
      case 'POND': return 'bg-blue-100 text-blue-700';
      case 'CAGE': return 'bg-purple-100 text-purple-700';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  // Count visible charts
  const visiblePieCharts = PIE_CHARTS.filter(c => localChartVisibility[c.key]).length;
  const visibleLineCharts = LINE_CHARTS.filter(c => localChartVisibility[c.key]).length;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Chart Settings"
      size="lg"
    >
      <div className="space-y-6 max-h-[70vh] overflow-y-auto">
        {/* Chart Visibility Section */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-3">
            Visible Charts
          </label>

          {/* Pie Charts */}
          <div className="mb-4">
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
              Pie Charts ({visiblePieCharts}/8)
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {PIE_CHARTS.map(chart => (
                <label
                  key={chart.key}
                  className={`
                    flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors text-sm
                    ${localChartVisibility[chart.key]
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 hover:border-gray-300 text-gray-600'}
                  `}
                >
                  <input
                    type="checkbox"
                    checked={localChartVisibility[chart.key]}
                    onChange={() => handleToggleChart(chart.key)}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <span className="truncate">{chart.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Line Charts */}
          <div>
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
              Line Charts ({visibleLineCharts}/8)
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {LINE_CHARTS.map(chart => (
                <label
                  key={chart.key}
                  className={`
                    flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors text-sm
                    ${localChartVisibility[chart.key]
                      ? 'border-green-500 bg-green-50 text-green-700'
                      : 'border-gray-200 hover:border-gray-300 text-gray-600'}
                  `}
                >
                  <input
                    type="checkbox"
                    checked={localChartVisibility[chart.key]}
                    onChange={() => handleToggleChart(chart.key)}
                    className="w-4 h-4 text-green-600 border-gray-300 rounded focus:ring-green-500"
                  />
                  <span className="truncate">{chart.label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* Time Range Selection */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Time Range (for Line Charts)
          </label>
          <div className="flex gap-3">
            {[
              { value: '7d', label: 'Last 7 days' },
              { value: '30d', label: 'Last 30 days' },
              { value: '90d', label: 'Last 90 days' },
            ].map(option => (
              <label
                key={option.value}
                className={`
                  flex items-center gap-2 px-4 py-2 rounded-lg border cursor-pointer transition-colors
                  ${localTimeRange === option.value
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-300 hover:border-gray-400'}
                `}
              >
                <input
                  type="radio"
                  name="timeRange"
                  value={option.value}
                  checked={localTimeRange === option.value}
                  onChange={() => setLocalTimeRange(option.value as '7d' | '30d' | '90d')}
                  className="sr-only"
                />
                <span className="text-sm">{option.label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Tank Selection */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium text-gray-700">
              Tank/Pond/Cage Filter
            </label>
            <span className="text-xs text-gray-500">
              {localSelectedIds.length} of {tanks.length} selected
            </span>
          </div>

          {/* Select All */}
          <div className="border border-gray-200 rounded-lg divide-y divide-gray-200 max-h-[250px] overflow-y-auto">
            <div className="p-3 bg-gray-50 sticky top-0">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={handleSelectAll}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <span className="text-sm font-medium text-gray-700">
                  Select All
                </span>
              </label>
            </div>

            {/* Grouped by category */}
            {Object.entries(groupedTanks).map(([category, categoryTanks]) => {
              if (categoryTanks.length === 0) return null;

              const categorySelected = categoryTanks.filter(t => localSelectedIds.includes(t.id)).length;
              const allCategorySelected = categorySelected === categoryTanks.length;
              const someCategorySelected = categorySelected > 0 && categorySelected < categoryTanks.length;

              return (
                <div key={category}>
                  {/* Category Header */}
                  <div className="p-3 bg-gray-50 border-t border-gray-200 first:border-t-0">
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={allCategorySelected}
                        ref={(el) => {
                          if (el) el.indeterminate = someCategorySelected;
                        }}
                        onChange={(e) => handleSelectCategory(category, e.target.checked)}
                        className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                      />
                      <span className={`text-sm font-medium ${getCategoryColor(category)}`}>
                        {category}s ({categoryTanks.length})
                      </span>
                    </label>
                  </div>

                  {/* Category Items */}
                  {categoryTanks.map(tank => (
                    <div key={tank.id} className="p-2 pl-10 hover:bg-gray-50">
                      <label className="flex items-center gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={localSelectedIds.includes(tank.id)}
                          onChange={() => handleToggleTank(tank.id)}
                          className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-gray-900">
                              {tank.name}
                            </span>
                            <span className={`px-1.5 py-0.5 text-xs rounded ${getCategoryBadgeColor(category)}`}>
                              {tank.code}
                            </span>
                          </div>
                        </div>
                      </label>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-4 border-t border-gray-200 sticky bottom-0 bg-white">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
          >
            Apply
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default ChartSettingsModal;
