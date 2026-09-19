/**
 * Process List Page
 * Displays list of saved processes with search, filter, and actions
 */

import React, { useState, useMemo, useCallback } from 'react';
import { useConfirm, DataTable, type DataTableColumn, Spinner, PageHeader, Button, Select } from '@aquaculture/shared-ui';
import { Link } from 'react-router-dom';
import {
  Plus,
  Search,
  Filter,
  MoreVertical,
  Play,
  Pause,
  Edit,
  Copy,
  Trash2,
  FileText,
  Clock,
  User,
  LayoutTemplate,
  RefreshCw,
  AlertCircle,
} from 'lucide-react';
import { useActiveProcesses, useProcess, Process } from '../../hooks/useProcess';

const statusConfig: Record<string, { label: string; color: string }> = {
  draft: { label: 'Draft', color: 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300' },
  active: { label: 'Active', color: 'bg-green-100 text-green-700' },
  inactive: { label: 'Inactive', color: 'bg-yellow-100 text-yellow-700' },
  archived: { label: 'Archived', color: 'bg-red-100 text-red-700' },
};

const ProcessListPage: React.FC = () => {
  const confirm = useConfirm();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Fetch processes from API
  const { processes, loading, error, refetch } = useActiveProcesses();
  const { deleteProcess, duplicateProcess, updateProcess } = useProcess();

  // Filter processes
  const filteredProcesses = useMemo(() => {
    return processes.filter((process) => {
      const matchesSearch =
        process.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (process.description?.toLowerCase().includes(searchTerm.toLowerCase()) ?? false);
      const matchesStatus = statusFilter === 'all' || process.status.toLowerCase() === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [processes, searchTerm, statusFilter]);

  const formatDate = (date: Date | string) => {
    const d = new Date(date);
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(d);
  };

  // Handle duplicate process
  const handleDuplicate = useCallback(async (process: Process) => {
    setActionLoading(process.id);
    setActiveDropdown(null);
    try {
      const newName = `${process.name} (Copy)`;
      const result = await duplicateProcess(process.id, newName);
      if (result.success) {
        refetch();
      } else {
        console.error('Failed to duplicate:', result.message);
      }
    } catch (err) {
      console.error('Failed to duplicate process:', err);
    } finally {
      setActionLoading(null);
    }
  }, [duplicateProcess, refetch]);

  // Handle delete process
  const handleDelete = useCallback(async (process: Process) => {
    if (!(await confirm({ title: `Delete "${process.name}"?`, message: 'The process and its diagram are removed.', confirmText: 'Delete', cancelText: 'Cancel', variant: 'danger' }))) {
      return;
    }
    setActionLoading(process.id);
    setActiveDropdown(null);
    try {
      const result = await deleteProcess(process.id);
      if (result.success) {
        refetch();
      } else {
        console.error('Failed to delete:', result.message);
      }
    } catch (err) {
      console.error('Failed to delete process:', err);
    } finally {
      setActionLoading(null);
    }
  }, [deleteProcess, refetch, confirm]);

  // Handle status change (activate/pause)
  const handleStatusChange = useCallback(async (process: Process, newStatus: 'active' | 'inactive') => {
    setActionLoading(process.id);
    setActiveDropdown(null);
    try {
      const result = await updateProcess({
        processId: process.id,
        status: newStatus,
      });
      if (result.success) {
        refetch();
      } else {
        console.error('Failed to update status:', result.message);
      }
    } catch (err) {
      console.error('Failed to update process status:', err);
    } finally {
      setActionLoading(null);
    }
  }, [updateProcess, refetch]);

  // Loading state
  if (loading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <Spinner size="lg" block />
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">Loading processes...</p>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <AlertCircle className="w-8 h-8 text-red-500 mx-auto" />
            <p className="mt-2 text-sm text-gray-900 dark:text-gray-100 font-medium">Failed to load processes</p>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{error}</p>
            <Button variant="primary" className="mt-4" onClick={refetch}>Try Again</Button>
          </div>
        </div>
      </div>
    );
  }

  const processColumns: DataTableColumn<Process>[] = [
    {
      key: 'process',
      header: 'Process',
      render: (_value, process) => (
        <>
          <Link
            to={`/sensor/unified-editor/${process.id}`}
            className="block"
          >
            <div className="font-medium text-gray-900 dark:text-gray-100 hover:text-blue-600">
              {process.name}
            </div>
            <div className="text-sm text-gray-500 dark:text-gray-400 line-clamp-1">
              {process.description || 'No description'}
            </div>
          </Link>
        </>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (_value, process) => {
        const config = statusConfig[status] || statusConfig.draft;
        return (
          <>
            <span
              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${config.color}`}
            >
              {config.label}
            </span>
          </>
        );
      },
    },
    {
      key: 'components',
      header: 'Components',
      render: (_value, process) => {
        const nodeCount = Array.isArray(process.nodes) ? process.nodes.length : 0;
        const edgeCount = Array.isArray(process.edges) ? process.edges.length : 0;
        return (
          <>
            {nodeCount} nodes, {edgeCount} connections
          </>
        );
      },
    },
    {
      key: 'lastModified',
      header: 'Last Modified',
      render: (_value, process) => (
        <>
          <div className="flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400">
            <Clock className="w-4 h-4" />
            {formatDate(process.updatedAt)}
          </div>
          {process.createdBy && (
            <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 mt-1">
              <User className="w-3 h-3" />
              {process.createdBy}
            </div>
          )}
        </>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (_value, process) => {
        const status = process.status.toLowerCase();
        const isActionLoading = actionLoading === process.id;
        return (
          <div className="relative inline-block">
            {isActionLoading ? (
              <Spinner size="md" color="gray" />
            ) : (
              <>
                <Button variant="ghost" iconOnly aria-label="More actions" onClick={() =>
                    setActiveDropdown(activeDropdown === process.id ? null : process.id)
                  }><MoreVertical className="w-4 h-4 text-gray-500 dark:text-gray-400" /></Button>

                {activeDropdown === process.id && (
                  <div className="absolute right-0 mt-2 w-48 bg-white dark:bg-gray-900 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-10">
                    <Link
                      to={`/sensor/unified-editor/${process.id}`}
                      className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                    >
                      <Edit className="w-4 h-4" />
                      Edit
                    </Link>
                    <Button variant="ghost" leftIcon={<Copy className="w-4 h-4" />} onClick={() => handleDuplicate(process)}>Duplicate</Button>
                    {status === 'active' ? (
                      <Button variant="ghost" leftIcon={<Pause className="w-4 h-4" />} onClick={() => handleStatusChange(process, 'inactive')}>Deactivate</Button>
                    ) : status !== 'archived' ? (
                      <Button variant="ghost" leftIcon={<Play className="w-4 h-4" />} onClick={() => handleStatusChange(process, 'active')}>Activate</Button>
                    ) : null}
                    <hr className="my-1 border-gray-200 dark:border-gray-700" />
                    <Button variant="ghost" leftIcon={<Trash2 className="w-4 h-4" />} onClick={() => handleDelete(process)}>Delete</Button>
                  </div>
                )}
              </>
            )}
          </div>
        );
      },
    }
  ];

  return (
    <div className="p-6">
      {/* Header */}
      <PageHeader
        title="Process Diagrams"
        description="Create and manage equipment connection diagrams"
        actions={
          <div className="flex gap-3">
            <Button variant="secondary" leftIcon={<RefreshCw className="w-4 h-4" />} onClick={refetch}>Refresh</Button>
            <Link
              to="/sensor/processes/templates"
              className="flex items-center gap-2 px-4 py-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              <LayoutTemplate className="w-4 h-4" />
              Templates
            </Link>
            <Link
              to="/sensor/unified-editor/new"
              className="flex items-center gap-2 px-4 py-2 text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Process
            </Link>
          </div>
        }
        className="mb-6"
      />

      {/* Filters */}
      <div className="flex gap-4 mb-6">
        {/* Search */}
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500 dark:text-gray-400" />
          <input
            type="text"
            placeholder="Search processes..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Status Filter */}
        <div className="relative">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 dark:text-gray-400" />
          <Select options={[{ value: 'all', label: 'All Status' }, { value: 'draft', label: 'Draft' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'archived', label: 'Archived' }]} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} />
        </div>
      </div>

      {/* Process List */}
      {filteredProcesses.length === 0 ? (
        <div className="text-center py-12 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
          <FileText className="w-12 h-12 mx-auto text-gray-500 dark:text-gray-400 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">No processes found</h3>
          <p className="text-gray-500 dark:text-gray-400 mb-4">
            {searchTerm || statusFilter !== 'all'
              ? 'Try adjusting your search or filters'
              : 'Get started by creating your first process diagram'}
          </p>
          <Link
            to="/sensor/unified-editor/new"
            className="inline-flex items-center gap-2 px-4 py-2 text-white bg-blue-600 rounded-lg hover:bg-blue-700"
          >
            <Plus className="w-4 h-4" />
            Create Process
          </Link>
        </div>
      ) : (
        <DataTable<Process>
          data={filteredProcesses}
          columns={processColumns}
          keyExtractor={(process) => process.id}
          emptyMessage="No processes found"
          searchable={false}
          sortable={false}
          stickyHeader={false}
        />
      )}
    </div>
  );
};

export default ProcessListPage;
