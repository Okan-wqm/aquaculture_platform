/**
 * Tanks & Ponds Analytics Tab
 *
 * KPI cards and charts for tank/pond performance metrics.
 * Uses mock data — will be replaced with GraphQL queries.
 */

import React from 'react';
import { Card, KpiCard } from '@aquaculture/shared-ui';
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

// ============================================================================
// Constants
// ============================================================================

const tooltipStyle = {
  backgroundColor: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
};

// ============================================================================
// Mock Data
// ============================================================================

const biomassByTank = [
  { tank: 'Tank A1', biomass: 18.5 },
  { tank: 'Tank A2', biomass: 16.2 },
  { tank: 'Tank B1', biomass: 15.8 },
  { tank: 'Pond 1', biomass: 14.3 },
  { tank: 'Tank B2', biomass: 13.7 },
  { tank: 'Pond 2', biomass: 12.1 },
  { tank: 'Tank C1', biomass: 11.4 },
  { tank: 'Tank C2', biomass: 10.8 },
  { tank: 'Pond 3', biomass: 9.5 },
  { tank: 'Tank D1', biomass: 8.2 },
];

const tankStatusData = [
  { name: 'Operational', value: 18, color: '#22c55e' },
  { name: 'Maintenance', value: 3, color: '#f59e0b' },
  { name: 'Fallow', value: 2, color: '#94a3b8' },
  { name: 'Quarantine', value: 1, color: '#ef4444' },
];

const waterTempData = [
  { date: 'Mar 1', avgTemp: 13.8 },
  { date: 'Mar 3', avgTemp: 14.0 },
  { date: 'Mar 5', avgTemp: 13.5 },
  { date: 'Mar 7', avgTemp: 14.2 },
  { date: 'Mar 9', avgTemp: 14.5 },
  { date: 'Mar 11', avgTemp: 14.1 },
  { date: 'Mar 13', avgTemp: 13.9 },
  { date: 'Mar 15', avgTemp: 14.3 },
  { date: 'Mar 17', avgTemp: 14.6 },
  { date: 'Mar 19', avgTemp: 14.8 },
  { date: 'Mar 21', avgTemp: 14.4 },
  { date: 'Mar 23', avgTemp: 14.0 },
  { date: 'Mar 25', avgTemp: 13.7 },
  { date: 'Mar 27', avgTemp: 14.1 },
  { date: 'Mar 29', avgTemp: 14.2 },
];

const mortalityData = [
  { date: 'Mar 1', daily: 12, cumulative: 12 },
  { date: 'Mar 3', daily: 8, cumulative: 20 },
  { date: 'Mar 5', daily: 15, cumulative: 35 },
  { date: 'Mar 7', daily: 5, cumulative: 40 },
  { date: 'Mar 9', daily: 10, cumulative: 50 },
  { date: 'Mar 11', daily: 7, cumulative: 57 },
  { date: 'Mar 13', daily: 3, cumulative: 60 },
  { date: 'Mar 15', daily: 9, cumulative: 69 },
  { date: 'Mar 17', daily: 6, cumulative: 75 },
  { date: 'Mar 19', daily: 4, cumulative: 79 },
  { date: 'Mar 21', daily: 11, cumulative: 90 },
  { date: 'Mar 23', daily: 8, cumulative: 98 },
  { date: 'Mar 25', daily: 5, cumulative: 103 },
  { date: 'Mar 27', daily: 7, cumulative: 110 },
  { date: 'Mar 29', daily: 3, cumulative: 113 },
];

// ============================================================================
// Component
// ============================================================================

interface TanksAnalyticsTabProps {
  dateRange: string;
}

const TanksAnalyticsTab: React.FC<TanksAnalyticsTabProps> = ({ dateRange: _dateRange }) => {
  return (
    <div className="space-y-6">
      {/* KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="Total Tanks"
          value={24}
          sparklineData={[20, 21, 22, 22, 23, 24]}
          variant="primary"
        />
        <KpiCard
          title="Avg. Biomass"
          value="12.4 t"
          trend={{ value: 8.2, direction: 'up', isPercentage: true }}
          variant="success"
        />
        <KpiCard
          title="Avg. Water Temp"
          value="14.2°C"
          trend={{ value: 0, direction: 'neutral' }}
          variant="info"
        />
        <KpiCard
          title="Mortality Rate"
          value="0.8%"
          trend={{ value: 0.3, direction: 'down', isPercentage: true }}
          variant="warning"
        />
      </div>

      {/* Charts Row 1 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Biomass by Tank */}
        <Card>
          <div className="p-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Biomass by Tank</h2>
            <p className="text-sm text-gray-500">Top 10 tanks by current biomass (tonnes)</p>
          </div>
          <div className="p-4">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={biomassByTank} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis type="number" stroke="#6b7280" />
                <YAxis dataKey="tank" type="category" stroke="#6b7280" width={80} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="biomass" name="Biomass (t)" fill="#0073e6" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* Tank Status Distribution */}
        <Card>
          <div className="p-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Tank Status Distribution</h2>
            <p className="text-sm text-gray-500">Current operational status of all tanks</p>
          </div>
          <div className="p-4">
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={tankStatusData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                >
                  {tankStatusData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {/* Charts Row 2 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Water Temperature Trend */}
        <Card>
          <div className="p-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Water Temperature Trend</h2>
            <p className="text-sm text-gray-500">Daily average temperature over 30 days</p>
          </div>
          <div className="p-4">
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={waterTempData}>
                <defs>
                  <linearGradient id="colorTemp" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.8} />
                    <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.1} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" stroke="#6b7280" />
                <YAxis stroke="#6b7280" domain={['auto', 'auto']} />
                <Tooltip contentStyle={tooltipStyle} />
                <Area
                  type="monotone"
                  dataKey="avgTemp"
                  name="Avg Temp (°C)"
                  stroke="#06b6d4"
                  fillOpacity={1}
                  fill="url(#colorTemp)"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* Mortality Trend */}
        <Card>
          <div className="p-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Mortality Trend</h2>
            <p className="text-sm text-gray-500">Daily mortality count and cumulative total</p>
          </div>
          <div className="p-4">
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={mortalityData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" stroke="#6b7280" />
                <YAxis yAxisId="left" stroke="#6b7280" />
                <YAxis yAxisId="right" orientation="right" stroke="#6b7280" />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend />
                <Bar yAxisId="left" dataKey="daily" name="Daily Mortality" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                <Line yAxisId="right" type="monotone" dataKey="cumulative" name="Cumulative" stroke="#ef4444" strokeWidth={2} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default TanksAnalyticsTab;
