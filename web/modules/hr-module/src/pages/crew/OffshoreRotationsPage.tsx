/**
 * Offshore Rotations Page
 *
 * Manages offshore work rotation schedules (e.g., 14-on/14-off patterns).
 * Displays rotation calendar, upcoming switches, and crew availability.
 */

import React, { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  RefreshCw,
  Calendar,
  Ship,
  Building2,
  Users,
  ArrowRight,
  Plus,
  Filter,
  ChevronLeft,
  ChevronRight,
  Clock,
  AlertTriangle,
} from 'lucide-react';
import { cn } from '@shared-ui/utils';
import {
  useWorkRotations,
  useEmployees,
  useCurrentlyOffshore,
} from '../../hooks';
import { DataTable, StatusBadge, EmployeeAvatar } from '../../components/common';
import type { Column } from '../../components/common';
import type { WorkRotation, Employee, RotationType, PaginationInput } from '../../types';

// ============================================================================
// Types
// ============================================================================

interface RotationCalendarDay {
  date: Date;
  offshore: Employee[];
  onshore: Employee[];
  transitioning: Employee[];
}

// ============================================================================
// Helper Functions
// ============================================================================

const ROTATION_TYPE_CONFIG: Record<RotationType, { label: string; color: string }> = {
  offshore: { label: 'Offshore', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  onshore: { label: 'Onshore', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
  field: { label: 'Field', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  vessel: { label: 'Vessel', color: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400' },
  mixed: { label: 'Mixed', color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' },
};

const getDaysInMonth = (year: number, month: number): Date[] => {
  const days: Date[] = [];
  const date = new Date(year, month, 1);
  while (date.getMonth() === month) {
    days.push(new Date(date));
    date.setDate(date.getDate() + 1);
  }
  return days;
};

const formatDate = (date: Date): string => {
  return date.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
};

// ============================================================================
// Components
// ============================================================================

interface StatCardProps {
  title: string;
  value: number | string;
  subtitle?: string;
  icon: React.ReactNode;
  color: string;
  isLoading?: boolean;
}

const StatCard: React.FC<StatCardProps> = ({ title, value, subtitle, icon, color, isLoading }) => (
  <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-medium text-gray-600 dark:text-gray-400">{title}</p>
        {isLoading ? (
          <div className="mt-1 h-8 w-16 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
        ) : (
          <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">{value}</p>
        )}
        {subtitle && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{subtitle}</p>}
      </div>
      <div className={cn('rounded-lg p-3', color)}>{icon}</div>
    </div>
  </div>
);

const UpcomingTransitionCard: React.FC<{ rotation: WorkRotation }> = ({ rotation }) => {
  const daysUntil = Math.ceil(
    (new Date(rotation.endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );
  const isUrgent = daysUntil <= 3;

  return (
    <div
      className={cn(
        'rounded-lg border p-4 transition-colors',
        isUrgent
          ? 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20'
          : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'
      )}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          {rotation.employee && (
            <EmployeeAvatar
              firstName={rotation.employee.firstName}
              lastName={rotation.employee.lastName}
              avatarUrl={rotation.employee.avatarUrl}
              size="sm"
            />
          )}
          <div>
            <p className="font-medium text-gray-900 dark:text-white">
              {rotation.employee?.firstName} {rotation.employee?.lastName}
            </p>
            <div className="mt-1 flex items-center gap-2 text-sm">
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium',
                  ROTATION_TYPE_CONFIG[rotation.rotationType].color
                )}
              >
                {rotation.rotationType === 'offshore' ? (
                  <Ship className="h-3 w-3" />
                ) : (
                  <Building2 className="h-3 w-3" />
                )}
                {ROTATION_TYPE_CONFIG[rotation.rotationType].label}
              </span>
              <ArrowRight className="h-3 w-3 text-gray-400" />
              <span className="text-gray-600 dark:text-gray-400">
                {rotation.rotationType === 'offshore' ? 'Onshore' : 'Offshore'}
              </span>
            </div>
          </div>
        </div>
        <div className="text-right">
          <p
            className={cn(
              'text-sm font-medium',
              isUrgent ? 'text-amber-700 dark:text-amber-400' : 'text-gray-900 dark:text-white'
            )}
          >
            {daysUntil} day{daysUntil !== 1 ? 's' : ''}
          </p>
          <p className="text-xs text-gray-500">
            {new Date(rotation.endDate).toLocaleDateString()}
          </p>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Offshore Rotations Page
// ============================================================================

export function OffshoreRotationsPage() {
  // State
  const [activeTab, setActiveTab] = useState<'schedule' | 'calendar' | 'history'>('schedule');
  const [rotationFilter, setRotationFilter] = useState<RotationType | ''>('');
  const [pagination, setPagination] = useState<PaginationInput>({ limit: 20, offset: 0 });
  const [calendarMonth, setCalendarMonth] = useState(new Date());

  // Data fetching
  const { data: rotations, isLoading: loadingRotations } = useWorkRotations(
    rotationFilter ? { rotationType: rotationFilter } : undefined
  );
  const { data: employees, isLoading: loadingEmployees } = useEmployees({}, { limit: 1000 });
  const { data: offshoreEmployees, isLoading: loadingOffshore } = useCurrentlyOffshore();

  // Calculate stats
  const activeRotations = rotations?.filter((r) => r.status === 'active') || [];
  const upcomingTransitions = rotations
    ?.filter((r) => {
      const endDate = new Date(r.endDate);
      const now = new Date();
      const daysUntil = Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      return daysUntil > 0 && daysUntil <= 7 && r.status === 'active';
    })
    .sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime()) || [];

  const offshoreRotationCount = activeRotations.filter((r) => r.rotationType === 'offshore').length;
  const onshoreRotationCount = activeRotations.filter((r) => r.rotationType === 'onshore').length;

  // Calendar days
  const calendarDays = useMemo(() => {
    return getDaysInMonth(calendarMonth.getFullYear(), calendarMonth.getMonth());
  }, [calendarMonth]);

  // Rotation columns
  const rotationColumns: Column<WorkRotation>[] = [
    {
      key: 'employee',
      header: 'Employee',
      sortable: true,
      accessor: (row) => (
        <div className="flex items-center gap-3">
          {row.employee && (
            <>
              <EmployeeAvatar
                firstName={row.employee.firstName}
                lastName={row.employee.lastName}
                avatarUrl={row.employee.avatarUrl}
                size="sm"
              />
              <div>
                <p className="font-medium text-gray-900 dark:text-white">
                  {row.employee.firstName} {row.employee.lastName}
                </p>
                <p className="text-sm text-gray-500">{row.employee.employeeNumber}</p>
              </div>
            </>
          )}
        </div>
      ),
    },
    {
      key: 'rotationType',
      header: 'Rotation Type',
      accessor: (row) => (
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium',
            ROTATION_TYPE_CONFIG[row.rotationType].color
          )}
        >
          {row.rotationType === 'offshore' || row.rotationType === 'vessel' ? (
            <Ship className="h-3 w-3" />
          ) : (
            <Building2 className="h-3 w-3" />
          )}
          {ROTATION_TYPE_CONFIG[row.rotationType].label}
        </span>
      ),
    },
    {
      key: 'pattern',
      header: 'Pattern',
      accessor: (row) => (
        <span className="text-gray-900 dark:text-white">
          {row.daysOn}/{row.daysOff}
        </span>
      ),
    },
    {
      key: 'dates',
      header: 'Current Period',
      sortable: true,
      accessor: (row) => (
        <div className="text-sm">
          <p className="text-gray-900 dark:text-white">
            {new Date(row.startDate).toLocaleDateString()} -{' '}
            {new Date(row.endDate).toLocaleDateString()}
          </p>
          {row.status === 'active' && (
            <p className="text-gray-500">
              {Math.ceil(
                (new Date(row.endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
              )}{' '}
              days remaining
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (row) => {
        const statusConfig: Record<string, { label: string; variant: 'success' | 'warning' | 'error' | 'neutral' }> = {
          active: { label: 'Active', variant: 'success' },
          pending: { label: 'Pending', variant: 'warning' },
          completed: { label: 'Completed', variant: 'neutral' },
          cancelled: { label: 'Cancelled', variant: 'error' },
        };
        const config = statusConfig[row.status] || statusConfig.pending;
        return <StatusBadge label={config.label} variant={config.variant} size="sm" />;
      },
    },
  ];

  const handlePageChange = (page: number) => {
    setPagination({
      ...pagination,
      offset: (page - 1) * (pagination.limit || 20),
    });
  };

  const navigateMonth = (direction: 'prev' | 'next') => {
    setCalendarMonth((prev) => {
      const newDate = new Date(prev);
      newDate.setMonth(prev.getMonth() + (direction === 'next' ? 1 : -1));
      return newDate;
    });
  };

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Offshore Rotations</h1>
          <p className="mt-1 text-gray-500 dark:text-gray-400">
            Manage work rotation schedules and crew transitions
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            to="/hr/crew"
            className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          >
            <Users className="h-4 w-4" />
            Crew
          </Link>
          <button className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
            <Plus className="h-4 w-4" />
            New Rotation
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          title="Active Rotations"
          value={activeRotations.length}
          icon={<RefreshCw className="h-5 w-5 text-indigo-600" />}
          color="bg-indigo-50 dark:bg-indigo-900/30"
          isLoading={loadingRotations}
        />
        <StatCard
          title="Offshore Now"
          value={offshoreRotationCount}
          subtitle="At sea"
          icon={<Ship className="h-5 w-5 text-blue-600" />}
          color="bg-blue-50 dark:bg-blue-900/30"
          isLoading={loadingRotations}
        />
        <StatCard
          title="Onshore Now"
          value={onshoreRotationCount}
          subtitle="On break"
          icon={<Building2 className="h-5 w-5 text-green-600" />}
          color="bg-green-50 dark:bg-green-900/30"
          isLoading={loadingRotations}
        />
        <StatCard
          title="Transitions"
          value={upcomingTransitions.length}
          subtitle="Next 7 days"
          icon={<ArrowRight className="h-5 w-5 text-amber-600" />}
          color="bg-amber-50 dark:bg-amber-900/30"
          isLoading={loadingRotations}
        />
      </div>

      {/* Upcoming Transitions Alert */}
      {upcomingTransitions.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="h-5 w-5 text-amber-600" />
            <h3 className="font-medium text-amber-900 dark:text-amber-100">
              Upcoming Crew Transitions ({upcomingTransitions.length})
            </h3>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {upcomingTransitions.slice(0, 6).map((rotation) => (
              <UpcomingTransitionCard key={rotation.id} rotation={rotation} />
            ))}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-4 border-b border-gray-200 dark:border-gray-700">
        <button
          onClick={() => setActiveTab('schedule')}
          className={cn(
            'border-b-2 pb-3 text-sm font-medium transition-colors',
            activeTab === 'schedule'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
          )}
        >
          Active Schedule
        </button>
        <button
          onClick={() => setActiveTab('calendar')}
          className={cn(
            'border-b-2 pb-3 text-sm font-medium transition-colors',
            activeTab === 'calendar'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
          )}
        >
          Calendar View
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={cn(
            'border-b-2 pb-3 text-sm font-medium transition-colors',
            activeTab === 'history'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
          )}
        >
          History
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'schedule' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="flex items-center gap-4">
            <select
              value={rotationFilter}
              onChange={(e) => setRotationFilter(e.target.value as RotationType | '')}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            >
              <option value="">All Rotation Types</option>
              <option value="offshore">Offshore</option>
              <option value="onshore">Onshore</option>
              <option value="field">Field</option>
              <option value="vessel">Vessel</option>
              <option value="mixed">Mixed</option>
            </select>
          </div>

          {/* Rotations Table */}
          <DataTable
            data={activeRotations}
            columns={rotationColumns}
            keyExtractor={(row) => row.id}
            isLoading={loadingRotations}
            emptyMessage="No active rotations found"
            total={activeRotations.length}
            page={Math.floor((pagination.offset || 0) / (pagination.limit || 20)) + 1}
            pageSize={pagination.limit || 20}
            onPageChange={handlePageChange}
          />
        </div>
      )}

      {activeTab === 'calendar' && (
        <div className="space-y-4">
          {/* Calendar Header */}
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {calendarMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </h3>
            <div className="flex items-center gap-2">
              <button
                onClick={() => navigateMonth('prev')}
                className="rounded-lg p-2 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button
                onClick={() => setCalendarMonth(new Date())}
                className="rounded-lg px-3 py-1 text-sm font-medium text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/30"
              >
                Today
              </button>
              <button
                onClick={() => navigateMonth('next')}
                className="rounded-lg p-2 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* Calendar Legend */}
          <div className="flex items-center gap-4 text-sm">
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded bg-blue-500" />
              <span className="text-gray-600 dark:text-gray-400">Offshore</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded bg-green-500" />
              <span className="text-gray-600 dark:text-gray-400">Onshore</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded bg-amber-500" />
              <span className="text-gray-600 dark:text-gray-400">Transition</span>
            </div>
          </div>

          {/* Calendar Grid */}
          <div className="rounded-xl border border-gray-200 bg-white overflow-hidden dark:border-gray-700 dark:bg-gray-800">
            {/* Weekday Headers */}
            <div className="grid grid-cols-7 border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                <div
                  key={day}
                  className="py-2 text-center text-sm font-medium text-gray-500 dark:text-gray-400"
                >
                  {day}
                </div>
              ))}
            </div>

            {/* Calendar Days */}
            <div className="grid grid-cols-7">
              {/* Padding for first week */}
              {Array.from({ length: calendarDays[0]?.getDay() || 0 }).map((_, i) => (
                <div key={`pad-${i}`} className="min-h-24 border-b border-r border-gray-100 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/50" />
              ))}

              {calendarDays.map((day) => {
                const isToday = day.toDateString() === new Date().toDateString();
                const dayRotations = rotations?.filter((r) => {
                  const start = new Date(r.startDate);
                  const end = new Date(r.endDate);
                  return day >= start && day <= end && r.status === 'active';
                }) || [];

                return (
                  <div
                    key={day.toISOString()}
                    className={cn(
                      'min-h-24 border-b border-r border-gray-100 p-2 dark:border-gray-700',
                      isToday && 'bg-indigo-50 dark:bg-indigo-900/20'
                    )}
                  >
                    <div
                      className={cn(
                        'mb-1 text-sm',
                        isToday
                          ? 'font-bold text-indigo-600'
                          : 'font-medium text-gray-900 dark:text-white'
                      )}
                    >
                      {day.getDate()}
                    </div>
                    <div className="space-y-1">
                      {dayRotations.slice(0, 3).map((rotation) => (
                        <div
                          key={rotation.id}
                          className={cn(
                            'truncate rounded px-1 py-0.5 text-xs',
                            rotation.rotationType === 'offshore'
                              ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300'
                              : 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300'
                          )}
                          title={`${rotation.employee?.firstName} ${rotation.employee?.lastName}`}
                        >
                          {rotation.employee?.firstName?.charAt(0)}. {rotation.employee?.lastName}
                        </div>
                      ))}
                      {dayRotations.length > 3 && (
                        <div className="text-xs text-gray-500">
                          +{dayRotations.length - 3} more
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'history' && (
        <div className="space-y-4">
          <DataTable
            data={rotations?.filter((r) => r.status === 'completed') || []}
            columns={rotationColumns}
            keyExtractor={(row) => row.id}
            isLoading={loadingRotations}
            emptyMessage="No rotation history found"
            total={rotations?.filter((r) => r.status === 'completed').length}
            page={1}
            pageSize={20}
            onPageChange={() => {}}
          />
        </div>
      )}
    </div>
  );
}

export default OffshoreRotationsPage;
