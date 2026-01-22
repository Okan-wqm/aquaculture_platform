/**
 * Leaves Management Page
 * Displays leave requests with filtering and approval workflow
 */

import React, { useState } from 'react';
import {
  Calendar,
  Plus,
  Search,
  Filter,
  Clock,
  CheckCircle,
  XCircle,
  Eye,
} from 'lucide-react';
import { cn } from '@aquaculture/shared-ui';
import { useAuth } from '@aquaculture/shared-ui';
import {
  useLeaveRequests,
  usePendingLeaveApprovals,
  useLeaveTypes,
  useApproveLeaveRequest,
  useRejectLeaveRequest,
} from '../../hooks';
import { DataTable, StatusBadge, EmployeeAvatar } from '../../components/common';
import type { Column } from '../../components/common';
import type { LeaveRequest, LeaveRequestFilterInput, LeaveRequestStatus, PaginationInput } from '../../types';
import { LEAVE_STATUS_CONFIG, LEAVE_CATEGORY_CONFIG } from '../../types';

export function LeavesPage() {
  const { user } = useAuth();
  const employeeId = user?.sub || '';

  // State
  const [activeTab, setActiveTab] = useState<'all' | 'pending' | 'mine'>('all');
  const [filter, setFilter] = useState<LeaveRequestFilterInput>({});
  const [pagination, setPagination] = useState<PaginationInput>({ limit: 20, offset: 0 });
  const [searchQuery, setSearchQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  // Data fetching
  const { data: allRequests, isLoading: loadingAll } = useLeaveRequests(
    activeTab === 'mine' ? { ...filter, employeeId } : filter,
    pagination
  );
  const { data: pendingApprovals, isLoading: loadingPending } = usePendingLeaveApprovals(employeeId);
  const { data: leaveTypes } = useLeaveTypes();

  // Mutations
  const approveMutation = useApproveLeaveRequest();
  const rejectMutation = useRejectLeaveRequest();

  const requests = activeTab === 'pending' ? pendingApprovals : allRequests?.items;
  const isLoading = activeTab === 'pending' ? loadingPending : loadingAll;

  // Table columns
  const columns: Column<LeaveRequest>[] = [
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
                <p className="text-sm text-gray-500">{row.requestNumber}</p>
              </div>
            </>
          )}
        </div>
      ),
    },
    {
      key: 'leaveType',
      header: 'Leave Type',
      accessor: (row) => {
        const config = row.leaveType?.category
          ? LEAVE_CATEGORY_CONFIG[row.leaveType.category]
          : null;
        return (
          <div className="flex items-center gap-2">
            <div
              className="h-3 w-3 rounded-full"
              style={{ backgroundColor: row.leaveType?.colorCode || '#6366f1' }}
            />
            <span className="text-gray-900 dark:text-white">{row.leaveType?.name}</span>
          </div>
        );
      },
    },
    {
      key: 'dates',
      header: 'Dates',
      sortable: true,
      accessor: (row) => (
        <div className="text-sm">
          <p className="text-gray-900 dark:text-white">
            {new Date(row.startDate).toLocaleDateString()} - {new Date(row.endDate).toLocaleDateString()}
          </p>
          <p className="text-gray-500">
            {row.totalDays} day{row.totalDays !== 1 ? 's' : ''}
            {row.isHalfDayStart && ' (half-day start)'}
            {row.isHalfDayEnd && ' (half-day end)'}
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      accessor: (row) => {
        const config = LEAVE_STATUS_CONFIG[row.status];
        return <StatusBadge label={config.label} variant={config.variant} size="sm" />;
      },
    },
    {
      key: 'actions',
      header: '',
      width: '150px',
      align: 'right',
      accessor: (row) => (
        <div className="flex items-center justify-end gap-2">
          {row.status === 'pending' && activeTab === 'pending' && (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  approveMutation.mutate({ id: row.id });
                }}
                disabled={approveMutation.isPending}
                className="rounded p-1 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20"
                title="Approve"
              >
                <CheckCircle className="h-4 w-4" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const reason = prompt('Enter rejection reason:');
                  if (reason) {
                    rejectMutation.mutate({ id: row.id, reason });
                  }
                }}
                disabled={rejectMutation.isPending}
                className="rounded p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                title="Reject"
              >
                <XCircle className="h-4 w-4" />
              </button>
            </>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              // Open detail modal
            }}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700"
            title="View Details"
          >
            <Eye className="h-4 w-4" />
          </button>
        </div>
      ),
    },
  ];

  const handleFilterChange = (key: keyof LeaveRequestFilterInput, value: any) => {
    setFilter((prev) => ({
      ...prev,
      [key]: value || undefined,
    }));
    setPagination({ ...pagination, offset: 0 });
  };

  const handlePageChange = (page: number) => {
    setPagination({
      ...pagination,
      offset: (page - 1) * (pagination.limit || 20),
    });
  };

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Leave Management</h1>
          <p className="mt-1 text-gray-500 dark:text-gray-400">
            Track and manage employee leave requests
          </p>
        </div>
        <button className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
          <Plus className="h-4 w-4" />
          New Request
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-4 border-b border-gray-200 dark:border-gray-700">
        <button
          onClick={() => setActiveTab('all')}
          className={cn(
            'border-b-2 pb-3 text-sm font-medium transition-colors',
            activeTab === 'all'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
          )}
        >
          All Requests
        </button>
        <button
          onClick={() => setActiveTab('pending')}
          className={cn(
            'flex items-center gap-2 border-b-2 pb-3 text-sm font-medium transition-colors',
            activeTab === 'pending'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
          )}
        >
          Pending Approvals
          {pendingApprovals && pendingApprovals.length > 0 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
              {pendingApprovals.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('mine')}
          className={cn(
            'border-b-2 pb-3 text-sm font-medium transition-colors',
            activeTab === 'mine'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
          )}
        >
          My Requests
        </button>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search requests..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-4 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          />
        </div>

        <button
          onClick={() => setShowFilters(!showFilters)}
          className={cn(
            'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ring-1',
            showFilters
              ? 'bg-indigo-50 text-indigo-600 ring-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400'
              : 'bg-white text-gray-700 ring-gray-300 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200'
          )}
        >
          <Filter className="h-4 w-4" />
          Filters
        </button>
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
                onChange={(e) => handleFilterChange('status', e.target.value as LeaveRequestStatus)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              >
                <option value="">All Statuses</option>
                <option value="pending">Pending</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Leave Type
              </label>
              <select
                value={filter.leaveTypeId || ''}
                onChange={(e) => handleFilterChange('leaveTypeId', e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              >
                <option value="">All Types</option>
                {leaveTypes?.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </select>
            </div>

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

      {/* Data Table */}
      <DataTable
        data={requests || []}
        columns={columns}
        keyExtractor={(row) => row.id}
        isLoading={isLoading}
        emptyMessage="No leave requests found"
        total={activeTab === 'pending' ? pendingApprovals?.length : allRequests?.total}
        page={Math.floor((pagination.offset || 0) / (pagination.limit || 20)) + 1}
        pageSize={pagination.limit || 20}
        onPageChange={handlePageChange}
      />
    </div>
  );
}

export default LeavesPage;
