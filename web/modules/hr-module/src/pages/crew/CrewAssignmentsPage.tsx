/**
 * Crew Assignments Page
 *
 * Manages offshore and onshore crew assignments with work area allocation.
 * Displays crew distribution, current assignments, and rotation status.
 */

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Ship,
  Building2,
  Users,
  MapPin,
  Calendar,
  Filter,
  Plus,
  Search,
  RefreshCw,
  Eye,
  Edit,
  Anchor,
  Clock,
} from 'lucide-react';
import { cn } from '@aquaculture/shared-ui';
import {
  useEmployees,
  useWorkAreas,
  useCrewAssignments,
  useCurrentlyOffshore,
} from '../../hooks';
import { DataTable, StatusBadge, EmployeeAvatar } from '../../components/common';
import { SeaLandSplitView } from '../../components/crew';
import type { Column } from '../../components/common';
import type { Employee, WorkArea, CrewAssignment, PersonnelCategory, PaginationInput } from '../../types';

// ============================================================================
// Types
// ============================================================================

interface StatCardProps {
  title: string;
  value: number | string;
  subtitle?: string;
  icon: React.ReactNode;
  color: string;
  isLoading?: boolean;
}

// ============================================================================
// Components
// ============================================================================

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

const WorkAreaCard: React.FC<{ workArea: WorkArea; employeeCount: number }> = ({
  workArea,
  employeeCount,
}) => {
  const typeConfig: Record<string, { icon: React.ReactNode; color: string }> = {
    sea_cage: { icon: <Anchor className="h-5 w-5" />, color: 'text-blue-600 bg-blue-50 dark:bg-blue-900/30' },
    vessel: { icon: <Ship className="h-5 w-5" />, color: 'text-cyan-600 bg-cyan-50 dark:bg-cyan-900/30' },
    feed_barge: { icon: <Ship className="h-5 w-5" />, color: 'text-teal-600 bg-teal-50 dark:bg-teal-900/30' },
    shore_facility: { icon: <Building2 className="h-5 w-5" />, color: 'text-green-600 bg-green-50 dark:bg-green-900/30' },
    processing_plant: { icon: <Building2 className="h-5 w-5" />, color: 'text-amber-600 bg-amber-50 dark:bg-amber-900/30' },
    hatchery: { icon: <Building2 className="h-5 w-5" />, color: 'text-purple-600 bg-purple-50 dark:bg-purple-900/30' },
    office: { icon: <Building2 className="h-5 w-5" />, color: 'text-gray-600 bg-gray-50 dark:bg-gray-700' },
  };

  const config = typeConfig[workArea.type] || typeConfig.office;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 transition-shadow hover:shadow-md dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className={cn('rounded-lg p-2', config.color)}>{config.icon}</div>
          <div>
            <h4 className="font-medium text-gray-900 dark:text-white">{workArea.name}</h4>
            <p className="text-sm text-gray-500 dark:text-gray-400 capitalize">
              {workArea.type.replace(/_/g, ' ')}
            </p>
          </div>
        </div>
        <StatusBadge
          label={workArea.isActive ? 'Active' : 'Inactive'}
          variant={workArea.isActive ? 'success' : 'neutral'}
          size="sm"
        />
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-gray-100 pt-3 dark:border-gray-700">
        <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
          <Users className="h-4 w-4" />
          <span>{employeeCount} assigned</span>
        </div>
        {workArea.coordinates && (
          <div className="flex items-center gap-1 text-sm text-gray-500">
            <MapPin className="h-3 w-3" />
            <span>
              {workArea.coordinates.latitude.toFixed(2)}, {workArea.coordinates.longitude.toFixed(2)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// Crew Assignments Page
// ============================================================================

export function CrewAssignmentsPage() {
  // State
  const [activeTab, setActiveTab] = useState<'overview' | 'assignments' | 'work-areas'>('overview');
  const [personnelFilter, setPersonnelFilter] = useState<PersonnelCategory | ''>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [pagination, setPagination] = useState<PaginationInput>({ limit: 20, offset: 0 });

  // Data fetching
  const { data: employees, isLoading: loadingEmployees } = useEmployees(
    {
      ...(personnelFilter && { personnelCategory: personnelFilter }),
      ...(searchQuery && { search: searchQuery }),
    },
    pagination
  );
  const { data: workAreas, isLoading: loadingWorkAreas } = useWorkAreas();
  const { data: offshoreEmployees, isLoading: loadingOffshore } = useCurrentlyOffshore();
  const { data: crewAssignments, isLoading: loadingAssignments } = useCrewAssignments();

  // Calculate stats
  const totalEmployees = employees?.total || 0;
  const offshoreCount = employees?.items?.filter((e) => e.personnelCategory === 'offshore').length || 0;
  const onshoreCount = employees?.items?.filter((e) => e.personnelCategory === 'onshore').length || 0;
  const hybridCount = employees?.items?.filter((e) => e.personnelCategory === 'hybrid').length || 0;
  const seaWorthyCount = employees?.items?.filter((e) => e.seaWorthy).length || 0;
  const activeWorkAreas = workAreas?.filter((wa) => wa.isActive).length || 0;

  // Separate lists for sea/land view
  const offshoreList = employees?.items?.filter((e) => e.personnelCategory === 'offshore') || [];
  const onshoreList = employees?.items?.filter((e) => e.personnelCategory === 'onshore') || [];

  // Crew assignment columns
  const assignmentColumns: Column<CrewAssignment>[] = [
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
      key: 'workArea',
      header: 'Work Area',
      accessor: (row) => (
        <div className="flex items-center gap-2">
          {row.workArea?.type === 'sea_cage' || row.workArea?.type === 'vessel' ? (
            <Ship className="h-4 w-4 text-blue-500" />
          ) : (
            <Building2 className="h-4 w-4 text-green-500" />
          )}
          <span className="text-gray-900 dark:text-white">{row.workArea?.name}</span>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      accessor: (row) => (
        <span className="text-gray-600 dark:text-gray-300">{row.role || 'General'}</span>
      ),
    },
    {
      key: 'dates',
      header: 'Assignment Period',
      accessor: (row) => (
        <div className="text-sm">
          <p className="text-gray-900 dark:text-white">
            {new Date(row.startDate).toLocaleDateString()}
            {row.endDate && ` - ${new Date(row.endDate).toLocaleDateString()}`}
          </p>
          {!row.endDate && <p className="text-gray-500">Ongoing</p>}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (row) => (
        <StatusBadge
          label={row.isActive ? 'Active' : 'Inactive'}
          variant={row.isActive ? 'success' : 'neutral'}
          size="sm"
        />
      ),
    },
  ];

  const handlePageChange = (page: number) => {
    setPagination({
      ...pagination,
      offset: (page - 1) * (pagination.limit || 20),
    });
  };

  const isLoading = loadingEmployees || loadingWorkAreas || loadingOffshore;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Crew Assignments</h1>
          <p className="mt-1 text-gray-500 dark:text-gray-400">
            Manage offshore and onshore crew distribution
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            to="/hr/crew/rotations"
            className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          >
            <RefreshCw className="h-4 w-4" />
            Rotations
          </Link>
          <button className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
            <Plus className="h-4 w-4" />
            New Assignment
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <StatCard
          title="Total Crew"
          value={totalEmployees}
          icon={<Users className="h-5 w-5 text-indigo-600" />}
          color="bg-indigo-50 dark:bg-indigo-900/30"
          isLoading={loadingEmployees}
        />
        <StatCard
          title="Offshore"
          value={offshoreCount}
          subtitle="At sea"
          icon={<Ship className="h-5 w-5 text-blue-600" />}
          color="bg-blue-50 dark:bg-blue-900/30"
          isLoading={loadingEmployees}
        />
        <StatCard
          title="Onshore"
          value={onshoreCount}
          subtitle="Land-based"
          icon={<Building2 className="h-5 w-5 text-green-600" />}
          color="bg-green-50 dark:bg-green-900/30"
          isLoading={loadingEmployees}
        />
        <StatCard
          title="Hybrid"
          value={hybridCount}
          subtitle="Rotational"
          icon={<RefreshCw className="h-5 w-5 text-amber-600" />}
          color="bg-amber-50 dark:bg-amber-900/30"
          isLoading={loadingEmployees}
        />
        <StatCard
          title="Sea Worthy"
          value={seaWorthyCount}
          subtitle="Certified"
          icon={<Anchor className="h-5 w-5 text-teal-600" />}
          color="bg-teal-50 dark:bg-teal-900/30"
          isLoading={loadingEmployees}
        />
        <StatCard
          title="Work Areas"
          value={activeWorkAreas}
          subtitle="Active sites"
          icon={<MapPin className="h-5 w-5 text-purple-600" />}
          color="bg-purple-50 dark:bg-purple-900/30"
          isLoading={loadingWorkAreas}
        />
      </div>

      {/* Tabs */}
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
          Overview
        </button>
        <button
          onClick={() => setActiveTab('assignments')}
          className={cn(
            'border-b-2 pb-3 text-sm font-medium transition-colors',
            activeTab === 'assignments'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
          )}
        >
          Assignments
        </button>
        <button
          onClick={() => setActiveTab('work-areas')}
          className={cn(
            'border-b-2 pb-3 text-sm font-medium transition-colors',
            activeTab === 'work-areas'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
          )}
        >
          Work Areas
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Sea/Land Split View */}
          <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                Crew Distribution
              </h3>
              <Link
                to="/hr/employees"
                className="text-sm font-medium text-indigo-600 hover:text-indigo-700"
              >
                View All
              </Link>
            </div>
            <SeaLandSplitView
              offshoreEmployees={offshoreList}
              onshoreEmployees={onshoreList}
              isLoading={loadingEmployees}
            />
          </div>

          {/* Currently Offshore */}
          {offshoreEmployees && offshoreEmployees.length > 0 && (
            <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <div className="mb-4 flex items-center gap-2">
                <Ship className="h-5 w-5 text-blue-600" />
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                  Currently Offshore ({offshoreEmployees.length})
                </h3>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {offshoreEmployees.slice(0, 6).map((employee) => (
                  <Link
                    key={employee.id}
                    to={`/hr/employees/${employee.id}`}
                    className="flex items-center gap-3 rounded-lg border border-gray-200 p-3 transition-colors hover:border-blue-300 hover:bg-blue-50 dark:border-gray-700 dark:hover:border-blue-700 dark:hover:bg-blue-900/20"
                  >
                    <EmployeeAvatar
                      firstName={employee.firstName}
                      lastName={employee.lastName}
                      avatarUrl={employee.avatarUrl}
                      size="sm"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="truncate font-medium text-gray-900 dark:text-white">
                        {employee.firstName} {employee.lastName}
                      </p>
                      <p className="truncate text-sm text-gray-500">
                        {employee.position?.title || 'Crew Member'}
                      </p>
                    </div>
                    <Anchor className="h-4 w-4 text-blue-500" />
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'assignments' && (
        <div className="space-y-4">
          {/* Search and Filters */}
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
              <select
                value={personnelFilter}
                onChange={(e) => setPersonnelFilter(e.target.value as PersonnelCategory | '')}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              >
                <option value="">All Categories</option>
                <option value="offshore">Offshore</option>
                <option value="onshore">Onshore</option>
                <option value="hybrid">Hybrid</option>
              </select>
            </div>
          </div>

          {/* Assignments Table */}
          <DataTable
            data={crewAssignments || []}
            columns={assignmentColumns}
            keyExtractor={(row) => row.id}
            isLoading={loadingAssignments}
            emptyMessage="No crew assignments found"
            total={crewAssignments?.length}
            page={Math.floor((pagination.offset || 0) / (pagination.limit || 20)) + 1}
            pageSize={pagination.limit || 20}
            onPageChange={handlePageChange}
          />
        </div>
      )}

      {activeTab === 'work-areas' && (
        <div className="space-y-4">
          {/* Work Areas Header */}
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {workAreas?.length || 0} work areas configured
            </p>
            <button className="flex items-center gap-2 text-sm font-medium text-indigo-600 hover:text-indigo-700">
              <Plus className="h-4 w-4" />
              Add Work Area
            </button>
          </div>

          {/* Work Areas Grid */}
          {loadingWorkAreas ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div
                  key={i}
                  className="h-32 animate-pulse rounded-lg bg-gray-200 dark:bg-gray-700"
                />
              ))}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {workAreas?.map((workArea) => (
                <WorkAreaCard
                  key={workArea.id}
                  workArea={workArea}
                  employeeCount={
                    crewAssignments?.filter((a) => a.workAreaId === workArea.id && a.isActive)
                      .length || 0
                  }
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default CrewAssignmentsPage;
