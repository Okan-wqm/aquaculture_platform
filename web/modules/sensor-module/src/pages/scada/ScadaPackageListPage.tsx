/**
 * SCADA Package List Page
 * Displays list of SCADA packages with search, status filter, and actions.
 */

import React, { useState, useMemo, useCallback } from 'react';
import { useConfirm, DataTable, type DataTableColumn, Spinner, PageHeader, Button, Select } from '@aquaculture/shared-ui';
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
  DRAFT: { label: 'Draft', color: 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300' },
  PUBLISHED: { label: 'Published', color: 'bg-green-100 text-green-700' },
  ARCHIVED: { label: 'Archived', color: 'bg-red-100 text-red-700' },
};

const ScadaPackageListPage: React.FC = () => {
  const confirm = useConfirm();
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
      if (!(await confirm({ title: `Delete package "${pkg.name}"?`, message: 'Its screens and deployments history are removed.', confirmText: 'Delete', cancelText: 'Cancel', variant: 'danger' }))) {
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
    [deleteMutation, refetch, confirm],
  );

  // Loading state
  if (loading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <Spinner size="lg" block />
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">Loading SCADA packages...</p>
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
            <p className="mt-2 text-sm text-gray-900 dark:text-gray-100 font-medium">Failed to load packages</p>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{error}</p>
            <Button variant="primary" className="mt-4" onClick={refetch}>Retry</Button>
          </div>
        </div>
      </div>
    );
  }

  const scadaPackageColumns: DataTableColumn<ScadaPackage>[] = [
    {
      key: 'packageName',
      header: 'Package Name',
      render: (_value, pkg) => (
        <>
          <Link
            to={`/sensor/scada-builder/${pkg.id}`}
            className="block"
          >
            <div className="font-medium text-gray-900 dark:text-gray-100 hover:text-purple-600">
              {pkg.name}
            </div>
            <div className="text-sm text-gray-500 dark:text-gray-400 line-clamp-1">
              {pkg.description || 'No description'}
            </div>
          </Link>
        </>
      ),
    },
    {
      key: 'version',
      header: 'Version',
      render: (_value, pkg) => (
        <>
          v{pkg.version}
        </>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (_value, pkg) => {
        const config = statusConfig[pkg.status] || statusConfig.DRAFT;
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
      key: 'screens',
      header: 'Screens',
      render: (_value, pkg) => {
        const screenCount = pkg.packageData?.screens?.length || 0;
        return (
          <>
            {screenCount} screens
          </>
        );
      },
    },
    {
      key: 'lastUpdated',
      header: 'Last Updated',
      render: (_value, pkg) => (
        <div className="flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400">
          <Clock className="w-4 h-4" />
          {formatDate(pkg.updatedAt)}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (_value, pkg) => (
        <div className="relative inline-block">
          <Button variant="ghost" iconOnly aria-label="More actions" onClick={() =>
              setActiveDropdown(activeDropdown === pkg.id ? null : pkg.id)
            }><MoreVertical className="w-4 h-4 text-gray-500 dark:text-gray-400" /></Button>

          {activeDropdown === pkg.id && (
            <div className="absolute right-0 mt-2 w-48 bg-white dark:bg-gray-900 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-10">
              <Link
                to={`/sensor/scada-builder/${pkg.id}`}
                className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                <Edit className="w-4 h-4" />
                Edit
              </Link>
              <Button variant="ghost" leftIcon={<Upload className="w-4 h-4" />} onClick={() => {
                  setActiveDropdown(null);
                  navigate(`/sensor/scada-builder/${pkg.id}?deploy=true`);
                }}>Deploy</Button>
              <hr className="my-1 border-gray-200 dark:border-gray-700" />
              <Button variant="ghost" leftIcon={<Trash2 className="w-4 h-4" />} onClick={() => handleDelete(pkg)}>Delete</Button>
            </div>
          )}
        </div>
      ),
    }
  ];

  return (
    <div className="p-6">
      {/* Header */}
      <PageHeader
        title="SCADA Packages"
        description="Deployable SCADA HMI packages for edge devices"
        actions={
          <div className="flex gap-3">
            <Button variant="secondary" leftIcon={<RefreshCw className="w-4 h-4" />} onClick={refetch}>Refresh</Button>
            <Link
              to="/sensor/scada-builder/new"
              className="flex items-center gap-2 px-4 py-2 text-white bg-purple-600 rounded-lg hover:bg-purple-700 transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Package
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
            placeholder="Search packages..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-purple-500"
          />
        </div>

        {/* Status Filter */}
        <div className="relative">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 dark:text-gray-400" />
          <Select options={[{ value: 'all', label: 'All Statuses' }, { value: 'DRAFT', label: 'Draft' }, { value: 'PUBLISHED', label: 'Published' }, { value: 'ARCHIVED', label: 'Archived' }]} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} />
        </div>
      </div>

      {/* Package List */}
      {filteredPackages.length === 0 ? (
        <div className="text-center py-12 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
          <Package className="w-12 h-12 mx-auto text-gray-500 dark:text-gray-400 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">No packages found</h3>
          <p className="text-gray-500 dark:text-gray-400 mb-4">
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
        <DataTable<ScadaPackage>
          data={filteredPackages}
          columns={scadaPackageColumns}
          keyExtractor={(pkg) => pkg.id}
          emptyMessage="No packages found"
          searchable={false}
          sortable={false}
          stickyHeader={false}
        />
      )}
    </div>
  );
};

export default ScadaPackageListPage;
