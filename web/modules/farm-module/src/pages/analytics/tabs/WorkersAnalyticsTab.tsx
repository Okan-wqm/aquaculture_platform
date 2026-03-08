/**
 * Workers Analytics Tab
 *
 * KPI cards and charts for worker performance metrics.
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

const tasksByWorker = [
  { worker: 'Ahmet K.', tasks: 45 },
  { worker: 'Mehmet Y.', tasks: 42 },
  { worker: 'Ali D.', tasks: 38 },
  { worker: 'Fatma S.', tasks: 35 },
  { worker: 'Hasan B.', tasks: 33 },
  { worker: 'Ayşe T.', tasks: 30 },
  { worker: 'Mustafa Ö.', tasks: 28 },
  { worker: 'Zeynep A.', tasks: 25 },
  { worker: 'Emre C.', tasks: 22 },
  { worker: 'Elif M.', tasks: 20 },
];

const roleDistribution = [
  { name: 'Manager', value: 2, color: '#6366f1' },
  { name: 'Technician', value: 5, color: '#0073e6' },
  { name: 'Feeder', value: 4, color: '#22c55e' },
  { name: 'Diver', value: 3, color: '#06b6d4' },
  { name: 'General', value: 4, color: '#f59e0b' },
];

const taskCompletionData = [
  { date: 'Mar 1', completed: 10, assigned: 12 },
  { date: 'Mar 3', completed: 14, assigned: 15 },
  { date: 'Mar 5', completed: 11, assigned: 13 },
  { date: 'Mar 7', completed: 16, assigned: 16 },
  { date: 'Mar 9', completed: 9, assigned: 12 },
  { date: 'Mar 11', completed: 13, assigned: 14 },
  { date: 'Mar 13', completed: 15, assigned: 15 },
  { date: 'Mar 15', completed: 12, assigned: 14 },
  { date: 'Mar 17', completed: 10, assigned: 11 },
  { date: 'Mar 19', completed: 14, assigned: 15 },
  { date: 'Mar 21', completed: 11, assigned: 13 },
  { date: 'Mar 23', completed: 13, assigned: 14 },
  { date: 'Mar 25', completed: 15, assigned: 16 },
  { date: 'Mar 27', completed: 12, assigned: 13 },
  { date: 'Mar 29', completed: 14, assigned: 14 },
];

const attendanceData = [
  { date: 'Mar 1', rate: 94.4 },
  { date: 'Mar 3', rate: 88.9 },
  { date: 'Mar 5', rate: 100 },
  { date: 'Mar 7', rate: 94.4 },
  { date: 'Mar 9', rate: 88.9 },
  { date: 'Mar 11', rate: 94.4 },
  { date: 'Mar 13', rate: 100 },
  { date: 'Mar 15', rate: 94.4 },
  { date: 'Mar 17', rate: 88.9 },
  { date: 'Mar 19', rate: 94.4 },
  { date: 'Mar 21', rate: 100 },
  { date: 'Mar 23', rate: 94.4 },
  { date: 'Mar 25', rate: 94.4 },
  { date: 'Mar 27', rate: 88.9 },
  { date: 'Mar 29', rate: 94.4 },
];

// ============================================================================
// Component
// ============================================================================

interface WorkersAnalyticsTabProps {
  dateRange: string;
}

const WorkersAnalyticsTab: React.FC<WorkersAnalyticsTabProps> = ({ dateRange: _dateRange }) => {
  return (
    <div className="space-y-6">
      {/* KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="Total Workers"
          value={18}
          variant="primary"
        />
        <KpiCard
          title="Avg. Tasks/Day"
          value="12.3"
          trend={{ value: 5, direction: 'up', isPercentage: true }}
          variant="success"
        />
        <KpiCard
          title="Attendance Rate"
          value="94.5%"
          trend={{ value: 1.2, direction: 'down', isPercentage: true }}
          variant="warning"
        />
        <KpiCard
          title="Active Workers"
          value={15}
          progress={{ current: 15, max: 18, label: '15 of 18' }}
          variant="info"
        />
      </div>

      {/* Charts Row 1 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Tasks by Worker */}
        <Card>
          <div className="p-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Tasks Completed by Worker</h2>
            <p className="text-sm text-gray-500">Top 10 workers by completed tasks</p>
          </div>
          <div className="p-4">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={tasksByWorker} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis type="number" stroke="#6b7280" />
                <YAxis dataKey="worker" type="category" stroke="#6b7280" width={80} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="tasks" name="Tasks Completed" fill="#0073e6" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* Worker Distribution by Role */}
        <Card>
          <div className="p-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Worker Distribution by Role</h2>
            <p className="text-sm text-gray-500">Breakdown of workers across roles</p>
          </div>
          <div className="p-4">
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={roleDistribution}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                >
                  {roleDistribution.map((entry, index) => (
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
        {/* Daily Task Completion Trend */}
        <Card>
          <div className="p-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Daily Task Completion Trend</h2>
            <p className="text-sm text-gray-500">Completed vs assigned tasks over time</p>
          </div>
          <div className="p-4">
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={taskCompletionData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" stroke="#6b7280" />
                <YAxis stroke="#6b7280" />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend />
                <Bar dataKey="completed" name="Completed" fill="#22c55e" radius={[4, 4, 0, 0]} />
                <Line type="monotone" dataKey="assigned" name="Assigned" stroke="#6366f1" strokeWidth={2} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* Attendance Over Time */}
        <Card>
          <div className="p-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Attendance Over Time</h2>
            <p className="text-sm text-gray-500">Daily attendance rate over 30 days</p>
          </div>
          <div className="p-4">
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={attendanceData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" stroke="#6b7280" />
                <YAxis stroke="#6b7280" domain={[80, 100]} />
                <Tooltip contentStyle={tooltipStyle} />
                <Line type="monotone" dataKey="rate" name="Attendance %" stroke="#0073e6" strokeWidth={2} dot={{ r: 3 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default WorkersAnalyticsTab;
