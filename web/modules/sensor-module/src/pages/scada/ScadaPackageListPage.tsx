/**
 * SCADA Package List Page
 * Displays list of SCADA packages with search, status filter, and actions.
 */

import React, { useState, useMemo, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Plus,
  Search,
  Filter,
  MoreVertical,
  Edit,
  Copy,
  Trash2,
  Upload,
  Monitor,
  Clock,
  RefreshCw,
  Loader2,
  AlertCircle,
  Package,
} from 'lucide-react';
import {
  useScadaPackages,
  useDeleteScadaPackage,
  ScadaPackage,
  ScadaPackageStatus,
} from '../../hooks/useScadaPackage';

const statusConfig: Record<string, { label: string; color: string }> = {
  DRAFT: { label: 'Draft', color: 'bg-gray-100 text-gray-700' },
  PUBLISHED: { label: 'Published', color: 'bg-green-100 text-green-700' },
  ARCHIVED: { label: 'Archived', color: 'bg-red-100 text-red-700' },
};

const ScadaPackageListPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null);

  // Fetch packages
  const filter = useMemo(() => {
    const f: { status?: ScadaPackageStatus; searchTerm?: string } = {};
    if (statusFilter !== 'all') f.status = statusFilter as ScadaPackageStatus;
    if (searchTerm) f.searchTerm = searchTerm;
    return f;
  }, [statusFilter, searchTerm]);

  const { packages, loading, error, refetch } = useScadaPackages(filter);
  const deleteMutation = useDeleteScadaPackage();

  // Client-side search fallback (API may not support searchTerm)
  const filteredPackages = useMemo(() => {
    if (!searchTerm) return packages;
    const term = searchTerm.toLowerCase();
    return packages.filter(
      (p) =>
        p.name.toLowerCase().includes(term) ||
        (p.description?.toLowerCase().includes(term) ?? false),
    );
  }, [packages, searchTerm]);

  const formatDate = (date: string) => {
    const d = new Date(date);
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(d);
  };

  const handleDelete = useCallback(
    async (pkg: ScadaPackage) => {
      if (!window.confirm(`Are you sure you want to delete this package "${pkg.name}"?`)) {
        return;
      }
      setActiveDropdown(null);
      try {
        await deleteMutation.mutateAsync(pkg.id);
        refetch();
      } catch (err) {
        console.error('Failed to delete package:', err);
      }
    },
    [deleteMutation, refetch],
  );

  // Loading state
  if (loading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <Loader2 className="w-8 h-8 animate-spin text-purple-600 mx-auto" />
            <p className="mt-2 text-sm text-gray-500">Loading SCADA packages...</p>
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
            <p className="mt-2 text-sm text-gray-900 font-medium">Failed to load packages</p>
            <p className="mt-1 text-sm text-gray-500">{error}</p>
            <button
              onClick={refetch}
              className="mt-4 px-4 py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700"
            >
              Retry
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
          <h1 className="text-2xl font-bold text-gray-900">SCADA Packages</h1>
          <p className="text-gray-500 mt-1">
            Deployable SCADA HMI packages for edge devices
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
            to="/sensor/scada-builder/new"
            className="flex items-center gap-2 px-4 py-2 text-white bg-purple-600 rounded-lg hover:bg-purple-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Package
          </Link>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-4 mb-6">
        {/* Search */}
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" />
          <input
            type="text"
            placeholder="Search packages..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
        </div>

        {/* Status Filter */}
        <div className="relative">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="pl-9 pr-8 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 appearance-none bg-white"
          >
            <option value="all">All Statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="PUBLISHED">Published</option>
            <option value="ARCHIVED">Archived</option>
          </select>
        </div>
      </div>

      {/* Package List */}
      {filteredPackages.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <Package className="w-12 h-12 mx-auto text-gray-500 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No packages found</h3>
          <p className="text-gray-500 mb-4">
            {searchTerm || statusFilter !== 'all'
              ? 'Try changing the search or filter'
              : 'Get started by creating your first SCADA package'}
          </p>
          <Link
            to="/sensor/scada-builder/new"
            className="inline-flex items-center gap-2 px-4 py-2 text-white bg-purple-600 rounded-lg hover:bg-purple-700"
          >
            <Plus className="w-4 h-4" />
            Create Package
          </Link>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Package Name
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Version
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Screens
                </th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Last Updated
                </th>
                <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filteredPackages.map((pkg) => {
                const config = statusConfig[pkg.status] || statusConfig.DRAFT;
                const screenCount = pkg.packageData?.screens?.length || 0;

                return (
                  <tr key={pkg.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4">
                      <Link
                        to={`/sensor/scada-builder/${pkg.id}`}
                        className="block"
                      >
                        <div className="font-medium text-gray-900 hover:text-purple-600">
                          {pkg.name}
                        </div>
                        <div className="text-sm text-gray-500 line-clamp-1">
                          {pkg.description || 'No description'}
                        </div>
                      </Link>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500">
                      v{pkg.version}
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${config.color}`}
                      >
                        {config.label}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500">
                      {screenCount} screens
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-1 text-sm text-gray-500">
                        <Clock className="w-4 h-4" />
                        {formatDate(pkg.updatedAt)}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="relative inline-block">
                        <button
                          onClick={() =>
                            setActiveDropdown(activeDropdown === pkg.id ? null : pkg.id)
                          }
                          className="p-2 hover:bg-gray-100 rounded-lg"
                        >
                          <MoreVertical className="w-4 h-4 text-gray-500" />
                        </button>

                        {activeDropdown === pkg.id && (
                          <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-10">
                            <Link
                              to={`/sensor/scada-builder/${pkg.id}`}
                              className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                            >
                              <Edit className="w-4 h-4" />
                              Edit
                            </Link>
                            <button
                              onClick={() => {
                                setActiveDropdown(null);
                                navigate(`/sensor/scada-builder/${pkg.id}?deploy=true`);
                              }}
                              className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                            >
                              <Upload className="w-4 h-4" />
                              Deploy
                            </button>
                            <hr className="my-1 border-gray-200" />
                            <button
                              onClick={() => handleDelete(pkg)}
                              className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50"
                            >
                              <Trash2 className="w-4 h-4" />
                              Delete
                            </button>
                          </div>
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

export default ScadaPackageListPage;
