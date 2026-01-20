/**
 * Employees List Page
 * Displays list of employees with filtering, sorting, and actions
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Search,
  Filter,
  Download,
  MoreVertical,
  Eye,
  Edit,
  Trash2,
  Ship,
  Building2,
} from 'lucide-react';
import { cn } from '@shared-ui/utils';
import { useEmployees, useDepartments, usePositions } from '../../hooks';
import { DataTable, StatusBadge, EmployeeAvatar, DepartmentBadge } from '../../components/common';
import type { Column } from '../../components/common';
import type { Employee, EmployeeFilterInput, EmployeeStatus, PersonnelCategory, PaginationInput } from '../../types';
import { EMPLOYEE_STATUS_CONFIG, PERSONNEL_CATEGORY_CONFIG } from '../../types';

export function EmployeesListPage() {
  const navigate = useNavigate();

  // State
  const [filter, setFilter] = useState<EmployeeFilterInput>({});
  const [pagination, setPagination] = useState<PaginationInput>({ limit: 20, offset: 0 });
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<string>('lastName');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [showFilters, setShowFilters] = useState(false);

  // Data fetching
  const { data: employees, isLoading } = useEmployees(
    { ...filter, search: searchQuery || undefined },
    pagination
  );
  const { data: departments } = useDepartments();
  const { data: positions } = usePositions();

  // Table columns
  const columns: Column<Employee>[] = [
    {
      key: 'employee',
      header: 'Employee',
      sortable: true,
      accessor: (row) => (
        <div className="flex items-center gap-3">
          <EmployeeAvatar
            firstName={row.firstName}
            lastName={row.lastName}
            avatarUrl={row.avatarUrl}
            size="sm"
          />
          <div>
            <p className="font-medium text-gray-900 dark:text-white">
              {row.firstName} {row.lastName}
            </p>
            <p className="text-sm text-gray-500">{row.employeeNumber}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'department',
      header: 'Department',
      sortable: true,
      accessor: (row) =>
        row.department ? (
          <DepartmentBadge
            name={row.department.name}
            colorCode={row.department.colorCode}
            size="sm"
          />
        ) : (
          <span className="text-gray-400">-</span>
        ),
    },
    {
      key: 'position',
      header: 'Position',
      accessor: (row) => (
        <span className="text-gray-600 dark:text-gray-300">
          {row.position?.title || '-'}
        </span>
      ),
    },
    {
      key: 'personnelCategory',
      header: 'Category',
      accessor: (row) => {
        if (!row.personnelCategory) return <span className="text-gray-400">-</span>;
        const config = PERSONNEL_CATEGORY_CONFIG[row.personnelCategory];
        return (
          <div className="flex items-center gap-1">
            {row.personnelCategory === 'offshore' ? (
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
      sortable: true,
      accessor: (row) => {
        const config = EMPLOYEE_STATUS_CONFIG[row.status];
        return <StatusBadge label={config.label} variant={config.variant} size="sm" />;
      },
    },
    {
      key: 'seaWorthy',
      header: 'Sea Worthy',
      align: 'center',
      accessor: (row) => (
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
      key: 'actions',
      header: '',
      width: '60px',
      align: 'right',
      accessor: (row) => (
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/hr/employees/${row.id}`);
            }}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700"
            title="View"
          >
            <Eye className="h-4 w-4" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/hr/employees/${row.id}/edit`);
            }}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700"
            title="Edit"
          >
            <Edit className="h-4 w-4" />
          </button>
        </div>
      ),
    },
  ];

  const handleSort = (key: string) => {
    if (sortBy === key) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(key);
      setSortOrder('asc');
    }
  };

  const handlePageChange = (page: number) => {
    setPagination({
      ...pagination,
      offset: (page - 1) * (pagination.limit || 20),
    });
  };

  const handleFilterChange = (key: keyof EmployeeFilterInput, value: any) => {
    setFilter((prev) => ({
      ...prev,
      [key]: value || undefined,
    }));
    setPagination({ ...pagination, offset: 0 });
  };

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Employees</h1>
          <p className="mt-1 text-gray-500 dark:text-gray-400">
            Manage your organization's workforce
          </p>
        </div>
        <button
          onClick={() => navigate('/hr/employees/new')}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Plus className="h-4 w-4" />
          Add Employee
        </button>
      </div>

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
              <select
                value={filter.status || ''}
                onChange={(e) => handleFilterChange('status', e.target.value as EmployeeStatus)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              >
                <option value="">All Statuses</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="on_leave">On Leave</option>
                <option value="probation">Probation</option>
                <option value="terminated">Terminated</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Department
              </label>
              <select
                value={filter.departmentId || ''}
                onChange={(e) => handleFilterChange('departmentId', e.target.value)}
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
              <select
                value={filter.personnelCategory || ''}
                onChange={(e) => handleFilterChange('personnelCategory', e.target.value as PersonnelCategory)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              >
                <option value="">All Categories</option>
                <option value="offshore">Offshore</option>
                <option value="onshore">Onshore</option>
                <option value="hybrid">Hybrid</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Sea Worthy
              </label>
              <select
                value={filter.seaWorthy === undefined ? '' : filter.seaWorthy.toString()}
                onChange={(e) =>
                  handleFilterChange(
                    'seaWorthy',
                    e.target.value === '' ? undefined : e.target.value === 'true'
                  )
                }
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              >
                <option value="">All</option>
                <option value="true">Certified</option>
                <option value="false">Not Certified</option>
              </select>
            </div>
          </div>

          <div className="mt-4 flex justify-end">
            <button
              onClick={() => {
                setFilter({});
                setSearchQuery('');
              }}
              className="text-sm text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
            >
              Clear all filters
            </button>
          </div>
        </div>
      )}

      {/* Selection Actions */}
      {selectedKeys.size > 0 && (
        <div className="flex items-center gap-4 rounded-lg bg-indigo-50 px-4 py-2 dark:bg-indigo-900/30">
          <span className="text-sm font-medium text-indigo-600 dark:text-indigo-400">
            {selectedKeys.size} selected
          </span>
          <div className="flex items-center gap-2">
            <button className="text-sm text-indigo-600 hover:text-indigo-700 dark:text-indigo-400">
              Bulk Edit
            </button>
            <button className="text-sm text-red-600 hover:text-red-700 dark:text-red-400">
              Delete Selected
            </button>
          </div>
          <button
            onClick={() => setSelectedKeys(new Set())}
            className="ml-auto text-sm text-gray-500 hover:text-gray-700"
          >
            Clear selection
          </button>
        </div>
      )}

      {/* Data Table */}
      <DataTable
        data={employees?.items || []}
        columns={columns}
        keyExtractor={(row) => row.id}
        isLoading={isLoading}
        emptyMessage="No employees found"
        total={employees?.total}
        page={Math.floor((pagination.offset || 0) / (pagination.limit || 20)) + 1}
        pageSize={pagination.limit || 20}
        onPageChange={handlePageChange}
        sortBy={sortBy}
        sortOrder={sortOrder}
        onSort={handleSort}
        selectable
        selectedKeys={selectedKeys}
        onSelectionChange={setSelectedKeys}
        onRowClick={(row) => navigate(`/hr/employees/${row.id}`)}
      />
    </div>
  );
}

export default EmployeesListPage;
