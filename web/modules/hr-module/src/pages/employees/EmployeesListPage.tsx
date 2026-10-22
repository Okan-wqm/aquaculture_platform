/**
 * Employees List Page
 * Displays list of employees with filtering, sorting, and actions
 */

import React, { useState, useMemo, useCallback, useDeferredValue } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Search, Filter, Eye, Edit, Ship, Building2 } from 'lucide-react';
import {
  cn,
  DataTable,
  type DataTableColumn,
  PageHeader,
  Button,
  Select,
  useI18n,
} from '@aquaculture/shared-ui';
import { useEmployees, useDepartments, useIsWorkforceManager, usePositions } from '../../hooks';
import { derivePaginationMetadataV1 } from '@platform/pagination-contracts';
import {
  StatusBadge,
  EmployeeAvatar,
  DepartmentBadge,
  ScopedDescription,
} from '../../components/common';
import { departmentLabel } from '../../utils/departmentLabel';
import type {
  Employee,
  EmployeeFilterInput,
  EmployeeStatus,
  PersonnelCategory,
  PaginationInput,
} from '../../types';
import { EMPLOYEE_STATUS_CONFIG, PERSONNEL_CATEGORY_CONFIG } from '../../types';

export function EmployeesListPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // SEC-007: only HR managers may hire, edit or perform destructive bulk actions
  const canManage = useIsWorkforceManager();

  // State
  // WHY: the Departments page links here with ?departmentId= — that department is the
  // list's starting filter (the server-side `departmentHrId` filter).
  const [filter, setFilter] = useState<EmployeeFilterInput>(() => ({
    departmentHrId: searchParams.get('departmentId') ?? undefined,
  }));
  const [pagination, setPagination] = useState<PaginationInput>({ limit: 20, page: 1 });
  const [searchQuery, setSearchQuery] = useState('');
  // PERF-006: defer the search value so rapid keystrokes are coalesced before
  // a new network request fires.  useDeferredValue yields the previous value
  // during the transition, so the table stays responsive while the query runs.
  const deferredSearch = useDeferredValue(searchQuery);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(false);

  // Data fetching
  const { data: employees, isLoading } = useEmployees({ ...filter }, pagination);
  const { data: departments } = useDepartments();
  const { data: positions } = usePositions();

  // PERF-004: memoize columns to avoid re-creating the array on every render
  const columns: DataTableColumn<Employee>[] = useMemo(
    () => [
      {
        key: 'employee',
        header: 'Employee',
        render: (_value, row) => (
          <div className="flex items-center gap-3">
            <EmployeeAvatar firstName={row.firstName} lastName={row.lastName} size="sm" />
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
        // The cell is the employee's department entity, so the CSV writes its name and module.
        exportValue: (row) => (row.departmentHr ? departmentLabel(row.departmentHr, t) : ''),
        render: (_value, row) =>
          row.departmentHr ? (
            <DepartmentBadge department={row.departmentHr} showModule size="sm" />
          ) : (
            <span className="text-gray-400 dark:text-gray-500">-</span>
          ),
      },
      {
        key: 'position',
        header: 'Position',
        render: (_value, row) => (
          <span className="text-gray-600 dark:text-gray-300">{row.position || '-'}</span>
        ),
      },
      {
        key: 'personnelCategory',
        header: 'Category',
        render: (_value, row) => {
          if (!row.personnelCategory)
            return <span className="text-gray-400 dark:text-gray-500">-</span>;
          const config = PERSONNEL_CATEGORY_CONFIG[row.personnelCategory];
          return (
            <div className="flex items-center gap-1">
              {row.personnelCategory === ('OFFSHORE' as PersonnelCategory) ? (
                <Ship className="h-4 w-4 text-info-500" />
              ) : (
                <Building2 className="h-4 w-4 text-success-500" />
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
              'inline-flex h-6 w-6 items-center justify-center rounded-md text-xs font-medium',
              row.seaWorthy
                ? 'bg-success-100 text-success-700 dark:bg-success-900/30 dark:text-success-400'
                : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
            )}
          >
            {row.seaWorthy ? '✓' : '-'}
          </span>
        ),
      },
      {
        key: 'actions',
        header: '',
        width: '60px',
        align: 'right',
        render: (_value, row) => (
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="View"
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/hr/employees/${row.id}`);
              }}
              title="View"
            >
              <Eye className="h-4 w-4" />
            </Button>
            {canManage && (
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Edit"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`/hr/employees/${row.id}/edit`);
                }}
                title="Edit"
              >
                <Edit className="h-4 w-4" />
              </Button>
            )}
          </div>
        ),
      },
    ],
    [navigate, canManage, t],
  );

  // PERF-009: stable keyExtractor so DataTable's useMemo deps don't invalidate
  const keyExtractor = useCallback((row: Employee) => row.id, []);

  const handlePageChange = (page: number) => {
    setPagination({
      ...pagination,
      page,
    });
  };

  // BUG-012 / BUG-013: replace any with specific union type
  const handleFilterChange = (
    key: keyof EmployeeFilterInput,
    value: string | boolean | undefined,
  ) => {
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
        description={<ScopedDescription text="Manage your organization's workforce" />}
        actions={
          canManage ? (
            <Button
              variant="primary"
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={() => navigate('/hr/employees/new')}
            >
              Add Employee
            </Button>
          ) : undefined
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
            className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-4 text-sm focus:border-primary-500 focus:outline-hidden focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ring-1',
              showFilters
                ? 'bg-primary-50 text-primary-600 ring-primary-200 dark:bg-primary-900/30 dark:text-primary-400 dark:ring-primary-800'
                : 'bg-white text-gray-700 ring-gray-300 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200 dark:ring-gray-600',
            )}
          >
            <Filter className="h-4 w-4" />
            Filters
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
              <Select
                fullWidth
                options={[
                  { value: '', label: 'All Statuses' },
                  { value: 'active', label: 'Active' },
                  { value: 'inactive', label: 'Inactive' },
                  { value: 'on_leave', label: 'On Leave' },
                  { value: 'probation', label: 'Probation' },
                  { value: 'terminated', label: 'Terminated' },
                ]}
                value={filter.status || ''}
                onChange={(e) => handleFilterChange('status', e.target.value as EmployeeStatus)}
              />
            </div>

            <div>
              <label
                htmlFor="employee-filter-department"
                className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                Department
              </label>
              <select
                id="employee-filter-department"
                value={filter.departmentHrId || ''}
                onChange={(e) => handleFilterChange('departmentHrId', e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              >
                <option value="">All Departments</option>
                {departments?.map((dept) => (
                  <option key={dept.id} value={dept.id}>
                    {departmentLabel(dept, t)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Personnel Category
              </label>
              <Select
                fullWidth
                options={[
                  { value: '', label: 'All Categories' },
                  { value: 'offshore', label: 'Offshore' },
                  { value: 'onshore', label: 'Onshore' },
                  { value: 'hybrid', label: 'Hybrid' },
                ]}
                value={filter.personnelCategory || ''}
                onChange={(e) =>
                  handleFilterChange('personnelCategory', e.target.value as PersonnelCategory)
                }
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Sea Worthy
              </label>
              <Select
                fullWidth
                options={[
                  { value: '', label: 'All' },
                  { value: 'true', label: 'Certified' },
                  { value: 'false', label: 'Not Certified' },
                ]}
                value={filter.seaWorthy === undefined ? '' : filter.seaWorthy.toString()}
                onChange={(e) =>
                  handleFilterChange(
                    'seaWorthy',
                    e.target.value === '' ? undefined : e.target.value === 'true',
                  )
                }
              />
            </div>
          </div>

          <div className="mt-4 flex justify-end">
            <Button
              variant="ghost"
              onClick={() => {
                setFilter({});
                setSearchQuery('');
              }}
            >
              Clear all filters
            </Button>
          </div>
        </div>
      )}

      {/* Selection Actions */}
      {selectedKeys.length > 0 && (
        <div className="flex items-center gap-4 rounded-lg bg-primary-50 px-4 py-2 dark:bg-primary-900/30">
          <span className="text-sm font-medium text-primary-600 dark:text-primary-400">
            {selectedKeys.length} selected
          </span>
          <div className="flex items-center gap-2">
            {canManage && (
              <>
                {/* BUG-016: bulk actions are guarded but not yet implemented */}
                <Button variant="ghost" disabled title="Bulk edit — not yet implemented">
                  Bulk Edit
                </Button>
                <Button variant="ghost" disabled title="Bulk delete — not yet implemented">
                  Delete Selected
                </Button>
              </>
            )}
          </div>
          <Button variant="ghost" onClick={() => setSelectedKeys([])}>
            Clear selection
          </Button>
        </div>
      )}

      {/* Data Table */}
      <DataTable<Employee>
        data={employees?.items ?? []}
        columns={columns}
        keyExtractor={keyExtractor}
        loading={isLoading}
        exportable
        exportFileName="employees"
        emptyMessage="No employees found"
        pagination={
          employees
            ? derivePaginationMetadataV1(
                employees.total,
                pagination.page || 1,
                pagination.limit || 20,
              )
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
