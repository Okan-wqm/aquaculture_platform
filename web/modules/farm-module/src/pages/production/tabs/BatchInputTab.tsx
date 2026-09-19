/**
 * Batch Input Tab
 * Batch list with CRUD operations and allocation functionality
 */
import React, { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBatchList, type BatchStatus, type Batch } from '../../../hooks/useBatches';
import { useSpeciesList } from '../../../hooks/useSpecies';
import { BatchFormModal } from '../components/BatchFormModal';
import { ApiError, DataTable, type DataTableColumn, Spinner, Button } from '@aquaculture/shared-ui';
import { ChartColumn, Layers, Plus, Scale, Search as SearchIcon, Users } from 'lucide-react';

// Status badge colors
const statusColors: Record<BatchStatus, string> = {
  QUARANTINE: 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200',
  ACTIVE: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  GROWING: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  PRE_HARVEST: 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  HARVESTING: 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200',
  HARVESTED: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
  TRANSFERRED: 'bg-primary-100 dark:bg-primary-900/40 text-primary-800 dark:text-primary-200',
  FAILED: 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200',
  CLOSED: 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400',
};

const statusLabels: Record<BatchStatus, string> = {
  QUARANTINE: 'Quarantine',
  ACTIVE: 'Active',
  GROWING: 'Growing',
  PRE_HARVEST: 'Pre-Harvest',
  HARVESTING: 'Harvesting',
  HARVESTED: 'Harvested',
  TRANSFERRED: 'Transferred',
  FAILED: 'Failed',
  CLOSED: 'Closed',
};

export const BatchInputTab: React.FC = () => {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<BatchStatus | 'all'>('all');
  const [showAddModal, setShowAddModal] = useState(false);

  // Fetch species list for name lookup (BUG-009)
  const { data: speciesData } = useSpeciesList();
  const speciesById = useMemo(() => {
    const map = new Map<string, string>();
    (speciesData?.items || []).forEach((s) =>
      map.set(s.id, s.commonName || s.scientificName || s.id),
    );
    return map;
  }, [speciesData]);

  // Fetch batches from API
  const {
    data: batchData,
    isLoading,
    error,
    refetch,
  } = useBatchList(
    {
      status: statusFilter !== 'all' ? [statusFilter] : undefined,
      searchTerm: searchTerm || undefined,
    },
    {
      // Fetch-all: the production list must show EVERY batch (a fixed 50-cap
      // hid batches on web while mobile paged through them all).
      fetchAll: true,
      sortBy: 'stockedAt',
      sortOrder: 'DESC',
    },
  );

  // PERF-005: The hook already passes searchTerm to the server-side query, so the
  // returned items are already filtered. Skip the redundant client-side re-filter
  // and use the server result directly.
  const filteredBatches = batchData?.items || [];

  // Calculate survival rate
  const getSurvivalRate = (batch: Batch): number => {
    if (batch.survivalRate !== undefined) return batch.survivalRate;
    if (batch.initialQuantity <= 0) return 100;
    return ((batch.initialQuantity - batch.totalMortality) / batch.initialQuantity) * 100;
  };

  // Get current biomass — useCallback so useMemo can safely include it as a dep (PERF-005)
  const getCurrentBiomass = useCallback((batch: Batch): number => {
    if (batch.currentBiomassKg !== undefined) return batch.currentBiomassKg;
    return batch.weight?.actual?.totalBiomass || batch.weight?.theoretical?.totalBiomass || 0;
  }, []);

  // Format date
  const formatDate = (date: string): string => {
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  // BUG-018: summaryStats must reflect the currently filtered set, not all batches (PERF-005: stable dep)
  const summaryStats = useMemo(() => {
    const activeBatches = filteredBatches.filter((b) => b.isActive);
    const totalStock = filteredBatches.reduce((sum, b) => sum + b.currentQuantity, 0);
    const totalBiomass = filteredBatches.reduce((sum, b) => sum + getCurrentBiomass(b), 0);
    const avgFCR =
      filteredBatches.length > 0
        ? filteredBatches.reduce((sum, b) => sum + (b.fcr?.actual || 0), 0) / filteredBatches.length
        : 0;

    return {
      activeBatches: activeBatches.length,
      totalStock,
      totalBiomass,
      avgFCR,
    };
  }, [filteredBatches, getCurrentBiomass]);

  type BatchRow = (typeof filteredBatches)[number];
  const batchRowColumns: DataTableColumn<BatchRow>[] = [
    {
      key: 'batch',
      header: 'Batch',
      render: (_value, batch) => (
        <div className="flex items-center">
          <div>
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {batch.batchNumber}
            </div>
            {batch.name && (
              <div className="text-sm text-gray-500 dark:text-gray-400">{batch.name}</div>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'species',
      header: 'Species',
      render: (_value, batch) => (
        <>
          {/* BUG-009: display resolved species name, fall back to truncated ID */}
          <div className="text-sm text-gray-900 dark:text-gray-100">
            {speciesById.get(batch.speciesId) ?? batch.speciesId.substring(0, 8) + '…'}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400 capitalize">
            {batch.inputType.replace('_', ' ')}
          </div>
        </>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (_value, batch) => (
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[batch.status]}`}
        >
          {statusLabels[batch.status]}
        </span>
      ),
    },
    {
      key: 'quantity',
      header: 'Quantity',
      align: 'right',
      render: (_value, batch) => (
        <>
          <div className="text-sm text-gray-900 dark:text-gray-100">
            {batch.currentQuantity.toLocaleString()}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            / {batch.initialQuantity.toLocaleString()}
          </div>
        </>
      ),
    },
    {
      key: 'biomassKg',
      header: 'Biomass (kg)',
      align: 'right',
      render: (_value, batch) => (
        <div className="text-sm text-gray-900 dark:text-gray-100">
          {getCurrentBiomass(batch).toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </div>
      ),
    },
    {
      key: 'survival',
      header: 'Survival',
      align: 'right',
      render: (_value, batch) => (
        <div
          className={`text-sm font-medium ${getSurvivalRate(batch) >= 95 ? 'text-success-600 dark:text-success-400' : getSurvivalRate(batch) >= 90 ? 'text-warning-600 dark:text-warning-400' : 'text-error-600 dark:text-error-400'}`}
        >
          {getSurvivalRate(batch).toFixed(1)}%
        </div>
      ),
    },
    {
      key: 'fcr',
      header: 'FCR',
      align: 'right',
      render: (_value, batch) => (
        <div
          className={`text-sm font-medium ${(batch.fcr?.actual || 0) <= (batch.fcr?.target || 1.5) ? 'text-success-600 dark:text-success-400' : 'text-error-600 dark:text-error-400'}`}
        >
          {batch.fcr?.actual?.toFixed(2) || '-'}
        </div>
      ),
    },
    {
      key: 'stocked',
      header: 'Stocked',
      render: (_value, batch) => formatDate(batch.stockedAt),
    },
    {
      key: 'spanClassnameSrOnlyActionsSpan',
      header: '<span className="sr-only">Actions</span>',
      render: (_value, batch) => <>View</>,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header with filters and add button */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex flex-1 gap-4">
          {/* Search */}
          <div className="relative flex-1 max-w-xs">
            <input
              type="text"
              placeholder="Search batches..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="block w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-info-500 focus:ring-info-500 sm:text-sm pl-10"
            />
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
              <SearchIcon className="h-5 w-5 text-gray-400 dark:text-gray-500" aria-hidden="true" />
            </div>
          </div>

          {/* Status Filter */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as BatchStatus | 'all')}
            className="block rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-info-500 focus:ring-info-500 sm:text-sm"
          >
            <option value="all">All Status</option>
            {Object.entries(statusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        {/* Add Button */}
        <Button variant="primary" onClick={() => setShowAddModal(true)}>
          <Plus className="w-4 h-4 mr-2" aria-hidden="true" />
          New Batch
        </Button>
      </div>

      {/* Error State */}
      {error && (
        <ApiError
          error={error}
          onRetry={() => refetch()}
          context="Batch listesi"
          showDetails={import.meta.env.DEV}
        />
      )}

      {/* Loading State */}
      {isLoading && (
        <div className="bg-white dark:bg-gray-900 shadow rounded-lg p-8">
          <div className="flex flex-col items-center justify-center">
            <Spinner size="lg" className="mb-4" />
            <p className="text-gray-500 dark:text-gray-400">Loading batches...</p>
          </div>
        </div>
      )}

      {/* Batch Table */}
      {!isLoading && !error && (
        <div className="bg-white dark:bg-gray-900 shadow rounded-lg overflow-hidden">
          <DataTable<BatchRow>
            data={filteredBatches}
            columns={batchRowColumns}
            keyExtractor={(batch) => batch.id}
            emptyMessage="No records found"
            searchable={false}
            sortable={false}
            stickyHeader={false}
          />

          {filteredBatches.length === 0 && (
            <div className="text-center py-12">
              <Layers
                className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500"
                aria-hidden="true"
              />
              <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                No batches found
              </h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Get started by creating a new batch.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <div className="p-3 bg-info-100 dark:bg-info-900/40 rounded-lg">
                <Layers className="w-6 h-6 text-info-600 dark:text-info-400" aria-hidden="true" />
              </div>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Active Batches</p>
              <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                {summaryStats.activeBatches}
              </p>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <div className="p-3 bg-success-100 dark:bg-success-900/40 rounded-lg">
                <Users
                  className="w-6 h-6 text-success-600 dark:text-success-400"
                  aria-hidden="true"
                />
              </div>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Stock</p>
              <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                {summaryStats.totalStock.toLocaleString()}
              </p>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <div className="p-3 bg-accent-100 dark:bg-accent-900/40 rounded-lg">
                <Scale
                  className="w-6 h-6 text-accent-600 dark:text-accent-400"
                  aria-hidden="true"
                />
              </div>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Biomass</p>
              <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                {summaryStats.totalBiomass.toLocaleString(undefined, { maximumFractionDigits: 0 })}{' '}
                kg
              </p>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <div className="p-3 bg-warning-100 dark:bg-warning-900/40 rounded-lg">
                <ChartColumn
                  className="w-6 h-6 text-warning-600 dark:text-warning-400"
                  aria-hidden="true"
                />
              </div>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Avg. FCR</p>
              <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                {summaryStats.avgFCR.toFixed(2)}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Batch Form Modal */}
      <BatchFormModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        onSuccess={() => {
          setShowAddModal(false);
          refetch();
        }}
      />
    </div>
  );
};

export default BatchInputTab;
