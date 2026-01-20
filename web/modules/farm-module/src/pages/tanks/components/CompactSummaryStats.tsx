/**
 * Compact Summary Stats Component
 * Single-row display of tank/pond/cage statistics with biomass totals
 */

import React, { useMemo } from 'react';
import type { TankWithBatch } from '../types';

interface CompactSummaryStatsProps {
  data: TankWithBatch[];
}

interface StatItem {
  label: string;
  count: number;
  biomass: number;
  color: string;
  icon: string;
}

export const CompactSummaryStats: React.FC<CompactSummaryStatsProps> = ({ data }) => {
  const stats = useMemo(() => {
    const tanks = data.filter(t => t.category.toUpperCase() === 'TANK');
    const ponds = data.filter(t => t.category.toUpperCase() === 'POND');
    const cages = data.filter(t => t.category.toUpperCase() === 'CAGE');
    const active = data.filter(t => t.status === 'ACTIVE' || t.status === 'OPERATIONAL');

    // Calculate total biomass for each category
    const tanksBiomass = tanks.reduce((sum, t) => sum + (t.biomass || 0), 0);
    const pondsBiomass = ponds.reduce((sum, t) => sum + (t.biomass || 0), 0);
    const cagesBiomass = cages.reduce((sum, t) => sum + (t.biomass || 0), 0);
    const totalBiomass = tanksBiomass + pondsBiomass + cagesBiomass;

    // Calculate average capacity usage for active tanks
    const activeTanksWithCapacity = active.filter(t => t.capacityUsedPercent !== undefined);
    const avgCapacity = activeTanksWithCapacity.length > 0
      ? activeTanksWithCapacity.reduce((sum, t) => sum + (t.capacityUsedPercent || 0), 0) / activeTanksWithCapacity.length
      : 0;

    return {
      total: {
        count: data.length,
        biomass: totalBiomass,
      },
      tanks: {
        count: tanks.length,
        biomass: tanksBiomass,
      },
      ponds: {
        count: ponds.length,
        biomass: pondsBiomass,
      },
      cages: {
        count: cages.length,
        biomass: cagesBiomass,
      },
      active: {
        count: active.length,
        avgCapacity: avgCapacity,
      },
    };
  }, [data]);

  const formatBiomass = (kg: number): string => {
    if (kg >= 1000) {
      return `${(kg / 1000).toFixed(1)}t`;
    }
    return `${kg.toFixed(0)} kg`;
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-2 mb-4">
      <div className="flex items-stretch divide-x divide-gray-200">
        {/* Total */}
        <div className="flex-1 px-3 py-1 text-center">
          <div className="flex items-center justify-center gap-1.5">
            <span className="text-gray-400 text-sm">Total</span>
            <span className="text-xl font-bold text-gray-900">{stats.total.count}</span>
          </div>
          <div className="text-xs text-gray-500">
            {formatBiomass(stats.total.biomass)}
          </div>
        </div>

        {/* Tanks */}
        <div className="flex-1 px-3 py-1 text-center">
          <div className="flex items-center justify-center gap-1.5">
            <span className="text-cyan-500 text-sm">Tanks</span>
            <span className="text-xl font-bold text-cyan-600">{stats.tanks.count}</span>
          </div>
          <div className="text-xs text-gray-500">
            {formatBiomass(stats.tanks.biomass)}
          </div>
        </div>

        {/* Ponds */}
        <div className="flex-1 px-3 py-1 text-center">
          <div className="flex items-center justify-center gap-1.5">
            <span className="text-blue-500 text-sm">Ponds</span>
            <span className="text-xl font-bold text-blue-600">{stats.ponds.count}</span>
          </div>
          <div className="text-xs text-gray-500">
            {formatBiomass(stats.ponds.biomass)}
          </div>
        </div>

        {/* Cages */}
        <div className="flex-1 px-3 py-1 text-center">
          <div className="flex items-center justify-center gap-1.5">
            <span className="text-purple-500 text-sm">Cages</span>
            <span className="text-xl font-bold text-purple-600">{stats.cages.count}</span>
          </div>
          <div className="text-xs text-gray-500">
            {formatBiomass(stats.cages.biomass)}
          </div>
        </div>

        {/* Active */}
        <div className="flex-1 px-3 py-1 text-center">
          <div className="flex items-center justify-center gap-1.5">
            <span className="text-green-500 text-sm">Active</span>
            <span className="text-xl font-bold text-green-600">{stats.active.count}</span>
          </div>
          <div className="text-xs text-gray-500">
            {stats.active.avgCapacity > 0 ? `${stats.active.avgCapacity.toFixed(0)}% cap` : '-'}
          </div>
        </div>
      </div>
    </div>
  );
};

export default CompactSummaryStats;
