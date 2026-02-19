/**
 * Attendance Page
 *
 * CRIT-4 / BUG-003: connected to real API. Mock data removed.
 * All local type aliases replaced with canonical HR module types.
 */

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock, Calendar, Users, CheckCircle, Filter, Download, Search } from 'lucide-react';
import { cn } from '@aquaculture/shared-ui';
import {
  useAttendanceRecords,
  useDailyAttendanceOverview,
  useCurrentEmployeeId,
} from '../hooks';
import { TimeClockWidget } from '../components/attendance/TimeClockWidget';
import { DataTable, StatusBadge } from '../components/common';
import type { Column } from '../components/common';
import type { AttendanceRecord, AttendanceFilterInput, PaginationInput } from '../types';
import { ATTENDANCE_STATUS_CONFIG } from '../types';

// ============================================================================
// Attendance Page
// ============================================================================

export function AttendancePage() {
  const employeeId = useCurrentEmployeeId();
  const today = new Date().toISOString().split('T')[0]!;

  const [activeTab, setActiveTab] = useState<'overview' | 'records'>('overview');
  const [filter, setFilter] = useState<AttendanceFilterInput>({});
  const [pagination, setPagination] = useState<PaginationInput>({ limit: 20, offset: 0 });
  const [showFilters, setShowFilters] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const { data: overview, isLoading: loadingOverview } = useDailyAttendanceOverview(today);
  const { data: records, isLoading: loadingRecords } = useAttendanceRecords(
    { ...filter },
    pagination
  );

  const handleFilterChange = (key: keyof AttendanceFilterInput, value: string | undefined) => {
    setFilter((prev) => ({ ...prev, [key]: value || undefined }));
    setPagination({ ...pagination, offset: 0 });
  };

  const handlePageChange = (page: number) => {
    setPagination({ ...pagination, offset: (page - 1) * (pagination.limit || 20) });
  };

  const columns: Column<AttendanceRecord>[] = [
    {
      key: 'employee',
      header: 'Employee',
      sortable: true,
      accessor: (row) => (
        <span className="font-medium text-gray-900 dark:text-white">
          {row.employeeId}
        </span>
      ),
    },
    {
      key: 'date',
      header: 'Date',
      sortable: true,
      accessor: (row) => (
        <span className="text-gray-700 dark:text-gray-300">
          {new Date(row.date).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: 'clockIn',
      header: 'Clock In',
      accessor: (row) => (
        <span className="text-gray-700 dark:text-gray-300">
          {row.clockInTime ? new Date(row.clockInTime).toLocaleTimeString() : '-'}
        </span>
      ),
    },
    {
      key: 'clockOut',
      header: 'Clock Out',
      accessor: (row) => (
        <span className="text-gray-700 dark:text-gray-300">
          {row.clockOutTime ? new Date(row.clockOutTime).toLocaleTimeString() : '-'}
        </span>
      ),
    },
    {
      key: 'workedTime',
      header: 'Worked',
      accessor: (row) => (
        <span className="text-gray-700 dark:text-gray-300">
          {row.workedMinutes > 0
            ? `${Math.floor(row.workedMinutes / 60)}h ${row.workedMinutes % 60}m`
            : '-'}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      accessor: (row) => {
        const config = ATTENDANCE_STATUS_CONFIG[row.status];
        return config ? (
          <StatusBadge label={config.label} variant={config.variant} size="sm" />
        ) : (
          <span className="text-gray-400">{row.status}</span>
        );
      },
    },
  ];

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Attendance</h1>
          <p className="mt-1 text-gray-500 dark:text-gray-400">
            Track employee time and attendance
          </p>
        </div>
        <Link
          to="/hr/scheduling"
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Calendar className="h-4 w-4" />
          Schedule
        </Link>
      </div>

      {/* Overview Cards */}
      {activeTab === 'overview' && (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">Present Today</p>
                  {loadingOverview ? (
                    <div className="mt-1 h-8 w-12 animate-pulse rounded bg-gray-200" />
                  ) : (
                    <p className="mt-1 text-2xl font-bold text-green-600">
                      {overview?.presentCount ?? '-'}
                    </p>
                  )}
                </div>
                <div className="rounded-lg bg-green-50 p-3 dark:bg-green-900/30">
                  <CheckCircle className="h-6 w-6 text-green-600" />
                </div>
              </div>
            </div>
            <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">Absent Today</p>
                  {loadingOverview ? (
                    <div className="mt-1 h-8 w-12 animate-pulse rounded bg-gray-200" />
                  ) : (
                    <p className="mt-1 text-2xl font-bold text-red-600">
                      {overview?.absentCount ?? '-'}
                    </p>
                  )}
                </div>
                <div className="rounded-lg bg-red-50 p-3 dark:bg-red-900/30">
                  <Users className="h-6 w-6 text-red-600" />
                </div>
              </div>
            </div>
            <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">On Leave</p>
                  {loadingOverview ? (
                    <div className="mt-1 h-8 w-12 animate-pulse rounded bg-gray-200" />
                  ) : (
                    <p className="mt-1 text-2xl font-bold text-amber-600">
                      {overview?.onLeaveCount ?? '-'}
                    </p>
                  )}
                </div>
                <div className="rounded-lg bg-amber-50 p-3 dark:bg-amber-900/30">
                  <Calendar className="h-6 w-6 text-amber-600" />
                </div>
              </div>
            </div>
            <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">Avg Hours Today</p>
                  {loadingOverview ? (
                    <div className="mt-1 h-8 w-12 animate-pulse rounded bg-gray-200" />
                  ) : (
                    <p className="mt-1 text-2xl font-bold text-indigo-600">
                      {overview?.averageWorkedHours?.toFixed(1) ?? '-'}
                      <span className="text-sm font-normal text-gray-500">h</span>
                    </p>
                  )}
                </div>
                <div className="rounded-lg bg-indigo-50 p-3 dark:bg-indigo-900/30">
                  <Clock className="h-6 w-6 text-indigo-600" />
                </div>
              </div>
            </div>
          </div>

          {/* Time Clock Widget */}
          {employeeId && (
            <div className="max-w-sm">
              <TimeClockWidget employeeId={employeeId} />
            </div>
          )}
        </>
      )}

      {/* Tab Navigation */}
      <div className="flex gap-4 border-b border-gray-200 dark:border-gray-700">
        <button
          onClick={() => setActiveTab('overview')}
          className={cn(
            'border-b-2 pb-3 text-sm font-medium transition-colors',
            activeTab === 'overview'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
          )}
        >
          Today's Overview
        </button>
        <button
          onClick={() => setActiveTab('records')}
          className={cn(
            'border-b-2 pb-3 text-sm font-medium transition-colors',
            activeTab === 'records'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
          )}
        >
          Attendance Records
        </button>
      </div>

      {/* Records Tab */}
      {activeTab === 'records' && (
        <>
          {/* Search & Filters */}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search employees..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-4 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowFilters(!showFilters)}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ring-1',
                  showFilters
                    ? 'bg-indigo-50 text-indigo-600 ring-indigo-200'
                    : 'bg-white text-gray-700 ring-gray-300 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200 dark:ring-gray-600'
                )}
              >
                <Filter className="h-4 w-4" />
                Filters
              </button>
              <button className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm font-medium text-gray-700 ring-1 ring-gray-300 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200 dark:ring-gray-600">
                <Download className="h-4 w-4" />
                Export
              </button>
            </div>
          </div>

          {/* Filter Panel */}
          {showFilters && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Start Date
                  </label>
                  <input
                    type="date"
                    value={filter.startDate || ''}
                    onChange={(e) => handleFilterChange('startDate', e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    End Date
                  </label>
                  <input
                    type="date"
                    value={filter.endDate || ''}
                    onChange={(e) => handleFilterChange('endDate', e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Status
                  </label>
                  <select
                    value={filter.status || ''}
                    onChange={(e) => handleFilterChange('status', e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                  >
                    <option value="">All</option>
                    <option value="present">Present</option>
                    <option value="absent">Absent</option>
                    <option value="late">Late</option>
                    <option value="on_leave">On Leave</option>
                  </select>
                </div>
              </div>
              <div className="mt-4 flex justify-end">
                <button
                  onClick={() => setFilter({})}
                  className="text-sm text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
                >
                  Clear all filters
                </button>
              </div>
            </div>
          )}

          <DataTable
            data={records?.items || []}
            columns={columns}
            keyExtractor={(row) => row.id}
            isLoading={loadingRecords}
            emptyMessage="No attendance records found"
            total={records?.total}
            page={Math.floor((pagination.offset || 0) / (pagination.limit || 20)) + 1}
            pageSize={pagination.limit || 20}
            onPageChange={handlePageChange}
          />
        </>
      )}
    </div>
  );
}

export default AttendancePage;
