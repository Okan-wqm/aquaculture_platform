/**
 * Process List Page
 * Displays list of saved processes with search, filter, and actions
 */

import React, { useState, useMemo, useCallback } from 'react';
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
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { useActiveProcesses, useProcess, Process } from '../../hooks/useProcess';

const statusConfig: Record<string, { label: string; color: string }> = {
  draft: { label: 'Draft', color: 'bg-gray-100 text-gray-700' },
  active: { label: 'Active', color: 'bg-green-100 text-green-700' },
  inactive: { label: 'Inactive', color: 'bg-yellow-100 text-yellow-700' },
  archived: { label: 'Archived', color: 'bg-red-100 text-red-700' },
};

const ProcessListPage: React.FC = () => {
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
    if (!window.confirm(`Are you sure you want to delete "${process.name}"?`)) {
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
  }, [deleteProcess, refetch]);

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
            <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto" />
            <p className="mt-2 text-sm text-gray-500">Loading processes...</p>
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
            <p className="mt-2 text-sm text-gray-900 font-medium">Failed to load processes</p>
            <p className="mt-1 text-sm text-gray-500">{error}</p>
            <button
              onClick={refetch}
              className="mt-4 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
            >
              Try Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Process Diagrams</h1>
          <p className="text-gray-500 mt-1">
            Create and manage equipment connection diagrams
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={refetch}
            className="flex items-center gap-2 px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
          <Link
            to="/sensor/processes/templates"
            className="flex items-center gap-2 px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <LayoutTemplate className="w-4 h-4" />
            Templates
          </Link>
          <Link
            to="/sensor/process/new"
            className="flex items-center gap-2 px-4 py-2 text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Process
          </Link>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-4 mb-6">
        {/* Search */}
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            placeholder="Search processes..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Status Filter */}
        <div className="relative">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="pl-9 pr-8 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 appearance-none bg-white"
          >
            <option value="all">All Status</option>
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="archived">Archived</option>
          </select>
        </div>
      </div>

      {/* Process List */}
      {filteredProcesses.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <FileText className="w-12 h-12 mx-auto text-gray-300 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No processes found</h3>
          <p className="text-gray-500 mb-4">
            {searchTerm || statusFilter !== 'all'
              ? 'Try adjusting your search or filters'
              : 'Get started by creating your first process diagram'}
          </p>
          <Link
            to="/sensor/process/new"
            className="inline-flex items-center gap-2 px-4 py-2 text-white bg-blue-600 rounded-lg hover:bg-blue-700"
          >
            <Plus className="w-4 h-4" />
            Create Process
          </Link>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Process
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Components
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Last Modified
                </th>
                <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filteredProcesses.map((process) => {
                const status = process.status.toLowerCase();
                const config = statusConfig[status] || statusConfig.draft;
                const nodeCount = Array.isArray(process.nodes) ? process.nodes.length : 0;
                const edgeCount = Array.isArray(process.edges) ? process.edges.length : 0;
                const isActionLoading = actionLoading === process.id;

                return (
                  <tr key={process.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4">
                      <Link
                        to={`/sensor/process/${process.id}`}
                        className="block"
                      >
                        <div className="font-medium text-gray-900 hover:text-blue-600">
                          {process.name}
                        </div>
                        <div className="text-sm text-gray-500 line-clamp-1">
                          {process.description || 'No description'}
                        </div>
                      </Link>
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${config.color}`}
                      >
                        {config.label}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500">
                      {nodeCount} nodes, {edgeCount} connections
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-1 text-sm text-gray-500">
                        <Clock className="w-4 h-4" />
                        {formatDate(process.updatedAt)}
                      </div>
                      {process.createdBy && (
                        <div className="flex items-center gap-1 text-xs text-gray-400 mt-1">
                          <User className="w-3 h-3" />
                          {process.createdBy}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="relative inline-block">
                        {isActionLoading ? (
                          <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                        ) : (
                          <>
                            <button
                              onClick={() =>
                                setActiveDropdown(activeDropdown === process.id ? null : process.id)
                              }
                              className="p-2 hover:bg-gray-100 rounded-lg"
                            >
                              <MoreVertical className="w-4 h-4 text-gray-500" />
                            </button>

                            {activeDropdown === process.id && (
                              <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-10">
                                <Link
                                  to={`/sensor/process/${process.id}`}
                                  className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                                >
                                  <Edit className="w-4 h-4" />
                                  Edit
                                </Link>
                                <button
                                  onClick={() => handleDuplicate(process)}
                                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                                >
                                  <Copy className="w-4 h-4" />
                                  Duplicate
                                </button>
                                {status === 'active' ? (
                                  <button
                                    onClick={() => handleStatusChange(process, 'inactive')}
                                    className="w-full flex items-center gap-2 px-4 py-2 text-sm text-yellow-700 hover:bg-yellow-50"
                                  >
                                    <Pause className="w-4 h-4" />
                                    Deactivate
                                  </button>
                                ) : status !== 'archived' ? (
                                  <button
                                    onClick={() => handleStatusChange(process, 'active')}
                                    className="w-full flex items-center gap-2 px-4 py-2 text-sm text-green-700 hover:bg-green-50"
                                  >
                                    <Play className="w-4 h-4" />
                                    Activate
                                  </button>
                                ) : null}
                                <hr className="my-1 border-gray-200" />
                                <button
                                  onClick={() => handleDelete(process)}
                                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50"
                                >
                                  <Trash2 className="w-4 h-4" />
                                  Delete
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default ProcessListPage;
