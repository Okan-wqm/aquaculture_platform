/**
 * Employees List Page
 * Displays list of employees with filtering, sorting, and actions
 */

import React, { useState, useMemo, useCallback, useDeferredValue } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Search,
  Filter,
  Download,
  Eye,
  Edit,
  Ship,
  Building2,
} from 'lucide-react';
import { cn, useAuth, DataTable, type DataTableColumn, PageHeader, Button, Select } from '@aquaculture/shared-ui';
import { useEmployees, useDepartments, usePositions, useToggleFarmWorker } from '../../hooks';
import { derivePaginationMetadataV1 } from '@platform/pagination-contracts';
import { StatusBadge, EmployeeAvatar, DepartmentBadge } from '../../components/common';
import type { Employee, EmployeeFilterInput, EmployeeStatus, PersonnelCategory, PaginationInput } from '../../types';
import { EMPLOYEE_STATUS_CONFIG, PERSONNEL_CATEGORY_CONFIG } from '../../types';

export function EmployeesListPage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  // SEC-007: only HR managers may perform destructive bulk actions
  const canBulkDelete =
    user?.role === 'SUPER_ADMIN' ||
    user?.role === 'TENANT_ADMIN' ||
    user?.role === 'MODULE_MANAGER';

  // State
  const [filter, setFilter] = useState<EmployeeFilterInput>({});
  const [pagination, setPagination] = useState<PaginationInput>({ limit: 20, page: 1 });
  const [searchQuery, setSearchQuery] = useState('');
  // PERF-006: defer the search value so rapid keystrokes are coalesced before
  // a new network request fires.  useDeferredValue yields the previous value
  // during the transition, so the table stays responsive while the query runs.
  const deferredSearch = useDeferredValue(searchQuery);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(false);

  // Data fetching
  const { data: employees, isLoading } = useEmployees(
    { ...filter },
    pagination
  );
  const { data: departments } = useDepartments();
  const { data: positions } = usePositions();
  const toggleFarmWorker = useToggleFarmWorker();

  // PERF-004: memoize columns to avoid re-creating the array on every render
  const columns: DataTableColumn<Employee>[] = useMemo(() => [
    {
      key: 'employee',
      header: 'Employee',
      render: (_value, row) => (
        <div className="flex items-center gap-3">
          <EmployeeAvatar
            firstName={row.firstName}
            lastName={row.lastName}
            size="sm"
          />
          <div>
            <p className="font-medium text-gray-900 dark:text-white">
              {row.firstName} {row.lastName}
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400">{row.employeeNumber}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'department',
      header: 'Department',
      render: (_value, row) =>
        row.department ? (
          <DepartmentBadge
            name={row.department}
            size="sm"
          />
        ) : (
          <span className="text-gray-400 dark:text-gray-500">-</span>
        ),
    },
    {
      key: 'position',
      header: 'Position',
      render: (_value, row) => (
        <span className="text-gray-600 dark:text-gray-300">
          {row.position || '-'}
        </span>
      ),
    },
    {
      key: 'personnelCategory',
      header: 'Category',
      render: (_value, row) => {
        if (!row.personnelCategory) return <span className="text-gray-400 dark:text-gray-500">-</span>;
        const config = PERSONNEL_CATEGORY_CONFIG[row.personnelCategory];
        return (
          <div className="flex items-center gap-1">
            {row.personnelCategory === ('OFFSHORE' as PersonnelCategory) ? (
              <Ship className="h-4 w-4 text-blue-500" />
            ) : (
              <Building2 className="h-4 w-4 text-green-500" />
            )}
            <StatusBadge label={config.label} variant={config.variant} size="sm" />
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      render: (_value, row) => {
        const config = EMPLOYEE_STATUS_CONFIG[row.status];
        return <StatusBadge label={config.label} variant={config.variant} size="sm" />;
      },
    },
    {
      key: 'seaWorthy',
      header: 'Sea Worthy',
      align: 'center',
      render: (_value, row) => (
        <span
          className={cn(
            'inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium',
            row.seaWorthy
              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
              : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500'
          )}
        >
          {row.seaWorthy ? '✓' : '-'}
        </span>
      ),
    },
    {
      key: 'farmWorker',
      header: 'Farm',
      align: 'center',
      render: (_value, row) => (
        <button
          onClick={(e) => {
            e.stopPropagation();
            toggleFarmWorker.mutate({ id: row.id, isFarmWorker: !row.isFarmWorker });
          }}
          className={cn(
            'inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium transition-colors',
            row.isFarmWorker
              ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400'
              : 'bg-gray-100 text-gray-400 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-500'
          )}
          title={row.isFarmWorker ? 'Visible in Farm module (click to hide)' : 'Hidden from Farm module (click to show)'}
        >
          {row.isFarmWorker ? '✓' : '-'}
        </button>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: '60px',
      align: 'right',
      render: (_value, row) => (
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" size="sm" iconOnly aria-label="View" onClick={(e) => {
              e.stopPropagation();
              navigate(`/hr/employees/${row.id}`);
            }} title="View"><Eye className="h-4 w-4" /></Button>
          <Button variant="ghost" size="sm" iconOnly aria-label="Edit" onClick={(e) => {
              e.stopPropagation();
              navigate(`/hr/employees/${row.id}/edit`);
            }} title="Edit"><Edit className="h-4 w-4" /></Button>
        </div>
      ),
    },
   
  ], [navigate, toggleFarmWorker.mutate]);

  // PERF-009: stable keyExtractor so DataTable's useMemo deps don't invalidate
  const keyExtractor = useCallback((row: Employee) => row.id, []);

  const handlePageChange = (page: number) => {
    setPagination({
      ...pagination,
      page,
    });
  };

  // BUG-012 / BUG-013: replace any with specific union type
  const handleFilterChange = (key: keyof EmployeeFilterInput, value: string | boolean | undefined) => {
    setFilter((prev) => ({
      ...prev,
      [key]: value || undefined,
    }));
    setPagination({ ...pagination, page: 1 });
  };

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <PageHeader
        title="Employees"
        description="Manage your organization's workforce"
        actions={
          <Button variant="primary" leftIcon={<Plus className="h-4 w-4" />} onClick={() => navigate('/hr/employees/new')}>Add Employee</Button>
        }
      />

      {/* Search and Filters */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
          <input
            type="text"
            placeholder="Search employees..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-4 text-sm focus:border-indigo-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ring-1',
              showFilters
                ? 'bg-indigo-50 text-indigo-600 ring-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400 dark:ring-indigo-800'
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
                Status
              </label>
              <Select fullWidth options={[{ value: '', label: 'All Statuses' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'on_leave', label: 'On Leave' }, { value: 'probation', label: 'Probation' }, { value: 'terminated', label: 'Terminated' }]} value={filter.status || ''} onChange={(e) => handleFilterChange('status', e.target.value as EmployeeStatus)} />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Department
              </label>
              <select
                value={filter.department || ''}
                onChange={(e) => handleFilterChange('department', e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              >
                <option value="">All Departments</option>
                {departments?.map((dept) => (
                  <option key={dept.id} value={dept.id}>
                    {dept.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Personnel Category
              </label>
              <Select fullWidth options={[{ value: '', label: 'All Categories' }, { value: 'offshore', label: 'Offshore' }, { value: 'onshore', label: 'Onshore' }, { value: 'hybrid', label: 'Hybrid' }]} value={filter.personnelCategory || ''} onChange={(e) => handleFilterChange('personnelCategory', e.target.value as PersonnelCategory)} />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Sea Worthy
              </label>
              <Select fullWidth options={[{ value: '', label: 'All' }, { value: 'true', label: 'Certified' }, { value: 'false', label: 'Not Certified' }]} value={filter.seaWorthy === undefined ? '' : filter.seaWorthy.toString()} onChange={(e) =>
         handleFilterChange(
          'seaWorthy',
          e.target.value === '' ? undefined : e.target.value === 'true'
         )
        } />
            </div>
          </div>

          <div className="mt-4 flex justify-end">
            <Button variant="ghost" onClick={() => {
                setFilter({});
                setSearchQuery('');
              }}>Clear all filters</Button>
          </div>
        </div>
      )}

      {/* Selection Actions */}
      {selectedKeys.length > 0 && (
        <div className="flex items-center gap-4 rounded-lg bg-indigo-50 px-4 py-2 dark:bg-indigo-900/30">
          <span className="text-sm font-medium text-indigo-600 dark:text-indigo-400">
            {selectedKeys.length} selected
          </span>
          <div className="flex items-center gap-2">
            {canBulkDelete && (
              <>
                {/* BUG-016: bulk actions are guarded but not yet implemented */}
                <Button variant="ghost" disabled title="Bulk edit — not yet implemented">Bulk Edit</Button>
                <Button variant="ghost" disabled title="Bulk delete — not yet implemented">Delete Selected</Button>
              </>
            )}
          </div>
          <Button variant="ghost" onClick={() => setSelectedKeys([])}>Clear selection</Button>
        </div>
      )}

      {/* Data Table */}
      <DataTable<Employee>
        data={employees?.items ?? []}
        columns={columns}
        keyExtractor={keyExtractor}
        loading={isLoading}
        emptyMessage="No employees found"
        pagination={
          employees
            ? derivePaginationMetadataV1(employees.total, pagination.page || 1, pagination.limit || 20)
            : undefined
        }
        onPageChange={handlePageChange}
        selectable
        selectedRows={selectedKeys}
        onSelectionChange={setSelectedKeys}
        onRowClick={(row) => navigate(`/hr/employees/${row.id}`)}
        searchable={false}
        sortable={false}
        stickyHeader={false}
      />
    </div>
  );
}

export default EmployeesListPage;
