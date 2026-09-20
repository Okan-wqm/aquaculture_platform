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
import {
  Button,
  cn,
  DataTable,
  PageHeader,
  Select,
  ToggleButton,
  type DataTableColumn,
} from '@aquaculture/shared-ui';
import { useWorkRotations, useEmployees, useCurrentlyOffshore } from '../../hooks';
import { derivePaginationMetadataV1 } from '@platform/pagination-contracts';
import { StatusBadge, EmployeeAvatar } from '../../components/common';
import type { WorkRotation, Employee, RotationType, PaginationInput } from '../../types';
import { RotationStatus } from '../../types';

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
  OFFSHORE: {
    label: 'Offshore',
    color: 'bg-info-100 text-info-700 dark:bg-info-900/30 dark:text-info-400',
  },
  ONSHORE: {
    label: 'Onshore',
    color: 'bg-success-100 text-success-700 dark:bg-success-900/30 dark:text-success-400',
  },
  FIELD: {
    label: 'Field',
    color: 'bg-warning-100 text-warning-700 dark:bg-warning-900/30 dark:text-warning-400',
  },
  VESSEL: {
    label: 'Vessel',
    color: 'bg-info-100 text-info-700 dark:bg-info-900/30 dark:text-info-400',
  },
  MIXED: {
    label: 'Mixed',
    color: 'bg-accent-100 text-accent-700 dark:bg-accent-900/30 dark:text-accent-400',
  },
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
    (new Date(rotation.endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
  );
  const isUrgent = daysUntil <= 3;

  return (
    <div
      className={cn(
        'rounded-lg border p-4 transition-colors',
        isUrgent
          ? 'border-warning-200 bg-warning-50 dark:border-warning-800 dark:bg-warning-900/20'
          : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800',
      )}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          {rotation.employee && (
            <EmployeeAvatar
              firstName={rotation.employee.firstName}
              lastName={rotation.employee.lastName}
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
                  ROTATION_TYPE_CONFIG[rotation.rotationType].color,
                )}
              >
                {rotation.rotationType === ('OFFSHORE' as RotationType) ? (
                  <Ship className="h-3 w-3" />
                ) : (
                  <Building2 className="h-3 w-3" />
                )}
                {ROTATION_TYPE_CONFIG[rotation.rotationType].label}
              </span>
              <ArrowRight className="h-3 w-3 text-gray-400 dark:text-gray-500" />
              <span className="text-gray-600 dark:text-gray-400">
                {rotation.rotationType === ('OFFSHORE' as RotationType) ? 'Onshore' : 'Offshore'}
              </span>
            </div>
          </div>
        </div>
        <div className="text-right">
          <p
            className={cn(
              'text-sm font-medium',
              isUrgent ? 'text-warning-700 dark:text-warning-400' : 'text-gray-900 dark:text-white',
            )}
          >
            {daysUntil} day{daysUntil !== 1 ? 's' : ''}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
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
  const [pagination, setPagination] = useState<PaginationInput>({ limit: 20, page: 1 });
  const [historyPage, setHistoryPage] = useState(1);
  const [calendarMonth, setCalendarMonth] = useState(new Date());

  // Data fetching
  const { data: rotations, isLoading: loadingRotations } = useWorkRotations(
    rotationFilter ? { rotationType: rotationFilter } : undefined,
  );
  const { data: employees, isLoading: loadingEmployees } = useEmployees({}, { limit: 1000 });
  const { data: offshoreEmployees, isLoading: loadingOffshore } = useCurrentlyOffshore();

  // Calculate stats
  const activeRotations = rotations?.filter((r) => r.status === RotationStatus.IN_PROGRESS) || [];
  const completedRotations = rotations?.filter((r) => r.status === RotationStatus.COMPLETED) || [];
  // The rotations query returns a flat array, so page it client-side: the
  // pagination bar has to move what the table shows, not only its label.
  const pageSize = pagination.limit || 20;
  const currentPage = pagination.page || 1;
  const pagedActiveRotations = activeRotations.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  const pagedCompletedRotations = completedRotations.slice(
    (historyPage - 1) * pageSize,
    historyPage * pageSize,
  );
  const upcomingTransitions =
    rotations
      ?.filter((r) => {
        const endDate = new Date(r.endDate);
        const now = new Date();
        const daysUntil = Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        return daysUntil > 0 && daysUntil <= 7 && r.status === RotationStatus.IN_PROGRESS;
      })
      .sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime()) || [];

  const offshoreRotationCount = activeRotations.filter(
    (r) => r.rotationType === ('OFFSHORE' as RotationType),
  ).length;
  const onshoreRotationCount = activeRotations.filter(
    (r) => r.rotationType === ('ONSHORE' as RotationType),
  ).length;

  // Calendar days
  const calendarDays = useMemo(() => {
    return getDaysInMonth(calendarMonth.getFullYear(), calendarMonth.getMonth());
  }, [calendarMonth]);

  // Rotation columns
  const rotationColumns: DataTableColumn<WorkRotation>[] = [
    {
      key: 'employee',
      header: 'Employee',
      render: (_value, row) => (
        <div className="flex items-center gap-3">
          {row.employee && (
            <>
              <EmployeeAvatar
                firstName={row.employee.firstName}
                lastName={row.employee.lastName}
                size="sm"
              />
              <div>
                <p className="font-medium text-gray-900 dark:text-white">
                  {row.employee.firstName} {row.employee.lastName}
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {row.employee.employeeNumber}
                </p>
              </div>
            </>
          )}
        </div>
      ),
    },
    {
      key: 'rotationType',
      header: 'Rotation Type',
      render: (_value, row) => (
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium',
            ROTATION_TYPE_CONFIG[row.rotationType].color,
          )}
        >
          {row.rotationType === ('OFFSHORE' as RotationType) ||
          row.rotationType === ('VESSEL' as RotationType) ? (
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
      render: (_value, row) => (
        <span className="text-gray-900 dark:text-white">
          {row.daysOn}/{row.daysOff}
        </span>
      ),
    },
    {
      key: 'dates',
      header: 'Current Period',
      render: (_value, row) => (
        <div className="text-sm">
          <p className="text-gray-900 dark:text-white">
            {new Date(row.startDate).toLocaleDateString()} -{' '}
            {new Date(row.endDate).toLocaleDateString()}
          </p>
          {row.status === RotationStatus.IN_PROGRESS && (
            <p className="text-gray-500 dark:text-gray-400">
              {Math.ceil((new Date(row.endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))}{' '}
              days remaining
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      // WHY: GraphQL returns UPPERCASE enum keys (IN_PROGRESS, SCHEDULED, etc.)
      // not lowercase DB values. The status lookup map must use UPPERCASE keys.
      render: (_value, row) => {
        const statusConfig: Record<
          string,
          { label: string; variant: 'success' | 'warning' | 'error' | 'neutral' }
        > = {
          IN_PROGRESS: { label: 'Active', variant: 'success' },
          SCHEDULED: { label: 'Scheduled', variant: 'warning' },
          COMPLETED: { label: 'Completed', variant: 'neutral' },
          CANCELLED: { label: 'Cancelled', variant: 'error' },
          EXTENDED: { label: 'Extended', variant: 'warning' },
        };
        const config = statusConfig[row.status] || statusConfig.SCHEDULED;
        return <StatusBadge label={config.label} variant={config.variant} size="sm" />;
      },
    },
  ];

  const handlePageChange = (page: number) => {
    setPagination({
      ...pagination,
      page,
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
      <PageHeader
        title="Offshore Rotations"
        description="Manage work rotation schedules and crew transitions"
        actions={
          <div className="flex items-center gap-3">
            <Link
              to="/hr/crew"
              className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
            >
              <Users className="h-4 w-4" />
              Crew
            </Link>
            <Button variant="primary" leftIcon={<Plus className="h-4 w-4" />}>
              New Rotation
            </Button>
          </div>
        }
      />

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          title="Active Rotations"
          value={activeRotations.length}
          icon={<RefreshCw className="h-5 w-5 text-primary-600 dark:text-primary-400" />}
          color="bg-primary-50 dark:bg-primary-900/30"
          isLoading={loadingRotations}
        />
        <StatCard
          title="Offshore Now"
          value={offshoreRotationCount}
          subtitle="At sea"
          icon={<Ship className="h-5 w-5 text-info-600 dark:text-info-400" />}
          color="bg-info-50 dark:bg-info-900/30"
          isLoading={loadingRotations}
        />
        <StatCard
          title="Onshore Now"
          value={onshoreRotationCount}
          subtitle="On break"
          icon={<Building2 className="h-5 w-5 text-success-600 dark:text-success-400" />}
          color="bg-success-50 dark:bg-success-900/30"
          isLoading={loadingRotations}
        />
        <StatCard
          title="Transitions"
          value={upcomingTransitions.length}
          subtitle="Next 7 days"
          icon={<ArrowRight className="h-5 w-5 text-warning-600 dark:text-warning-400" />}
          color="bg-warning-50 dark:bg-warning-900/30"
          isLoading={loadingRotations}
        />
      </div>

      {/* Upcoming Transitions Alert */}
      {upcomingTransitions.length > 0 && (
        <div className="rounded-xl border border-warning-200 bg-warning-50 p-4 dark:border-warning-800 dark:bg-warning-900/20">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="h-5 w-5 text-warning-600 dark:text-warning-400" />
            <h3 className="font-medium text-warning-900 dark:text-warning-100">
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
        <ToggleButton
          onClick={() => setActiveTab('schedule')}
          pressed={activeTab === 'schedule'}
          className="border-b-2 pb-3 text-sm font-medium transition-colors"
          pressedClassName="border-primary-600 text-primary-600 dark:text-primary-400"
          idleClassName="border-transparent text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-500 hover:text-gray-700 dark:hover:text-gray-100"
        >
          Active Schedule
        </ToggleButton>
        <ToggleButton
          onClick={() => setActiveTab('calendar')}
          pressed={activeTab === 'calendar'}
          className="border-b-2 pb-3 text-sm font-medium transition-colors"
          pressedClassName="border-primary-600 text-primary-600 dark:text-primary-400"
          idleClassName="border-transparent text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-500 hover:text-gray-700 dark:hover:text-gray-100"
        >
          Calendar View
        </ToggleButton>
        <ToggleButton
          onClick={() => setActiveTab('history')}
          pressed={activeTab === 'history'}
          className="border-b-2 pb-3 text-sm font-medium transition-colors"
          pressedClassName="border-primary-600 text-primary-600 dark:text-primary-400"
          idleClassName="border-transparent text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-500 hover:text-gray-700 dark:hover:text-gray-100"
        >
          History
        </ToggleButton>
      </div>

      {/* Tab Content */}
      {activeTab === 'schedule' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="flex items-center gap-4">
            {/* WHY: GraphQL RotationType enum values are UPPERCASE keys.
                Using lowercase values causes the filter query to return a 400 error. */}
            <Select
              options={[
                { value: '', label: 'All Rotation Types' },
                { value: 'OFFSHORE', label: 'Offshore' },
                { value: 'ONSHORE', label: 'Onshore' },
                { value: 'FIELD', label: 'Field' },
                { value: 'VESSEL', label: 'Vessel' },
                { value: 'MIXED', label: 'Mixed' },
              ]}
              value={rotationFilter}
              onChange={(e) => setRotationFilter(e.target.value as RotationType | '')}
            />
          </div>

          {/* Rotations Table */}
          <DataTable<WorkRotation>
            data={pagedActiveRotations}
            columns={rotationColumns}
            keyExtractor={(row) => row.id}
            loading={loadingRotations}
            emptyMessage="No active rotations found"
            pagination={derivePaginationMetadataV1(activeRotations.length, currentPage, pageSize)}
            onPageChange={handlePageChange}
            searchable={false}
            sortable={false}
            stickyHeader={false}
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
              <Button
                variant="ghost"
                iconOnly
                aria-label="Previous"
                onClick={() => navigateMonth('prev')}
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setCalendarMonth(new Date())}>
                Today
              </Button>
              <Button
                variant="ghost"
                iconOnly
                aria-label="Next"
                onClick={() => navigateMonth('next')}
              >
                <ChevronRight className="h-5 w-5" />
              </Button>
            </div>
          </div>

          {/* Calendar Legend */}
          <div className="flex items-center gap-4 text-sm">
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded bg-info-500" />
              <span className="text-gray-600 dark:text-gray-400">Offshore</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded bg-success-500" />
              <span className="text-gray-600 dark:text-gray-400">Onshore</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded bg-warning-500" />
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
                <div
                  key={`pad-${i}`}
                  className="min-h-24 border-b border-r border-gray-100 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/50"
                />
              ))}

              {calendarDays.map((day) => {
                const isToday = day.toDateString() === new Date().toDateString();
                const dayRotations =
                  rotations?.filter((r) => {
                    const start = new Date(r.startDate);
                    const end = new Date(r.endDate);
                    return day >= start && day <= end && r.status === RotationStatus.IN_PROGRESS;
                  }) || [];

                return (
                  <div
                    key={day.toISOString()}
                    className={cn(
                      'min-h-24 border-b border-r border-gray-100 p-2 dark:border-gray-700',
                      isToday && 'bg-primary-50 dark:bg-primary-900/20',
                    )}
                  >
                    <div
                      className={cn(
                        'mb-1 text-sm',
                        isToday
                          ? 'font-bold text-primary-600 dark:text-primary-400'
                          : 'font-medium text-gray-900 dark:text-white',
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
                            rotation.rotationType === ('OFFSHORE' as RotationType)
                              ? 'bg-info-100 text-info-700 dark:bg-info-900/50 dark:text-info-300'
                              : 'bg-success-100 text-success-700 dark:bg-success-900/50 dark:text-success-300',
                          )}
                          title={`${rotation.employee?.firstName} ${rotation.employee?.lastName}`}
                        >
                          {rotation.employee?.firstName?.charAt(0)}. {rotation.employee?.lastName}
                        </div>
                      ))}
                      {dayRotations.length > 3 && (
                        <div className="text-xs text-gray-500 dark:text-gray-400">
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
          <DataTable<WorkRotation>
            data={pagedCompletedRotations}
            columns={rotationColumns}
            keyExtractor={(row) => row.id}
            loading={loadingRotations}
            emptyMessage="No rotation history found"
            pagination={derivePaginationMetadataV1(
              completedRotations.length,
              historyPage,
              pageSize,
            )}
            onPageChange={setHistoryPage}
            searchable={false}
            sortable={false}
            stickyHeader={false}
          />
        </div>
      )}
    </div>
  );
}

export default OffshoreRotationsPage;
