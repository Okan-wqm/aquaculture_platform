/**
 * Batch Input Tab
 * Batch list with CRUD operations and allocation functionality
 */
import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBatchList, type BatchStatus, type Batch } from '../../../hooks/useBatches';
import { BatchFormModal } from '../components/BatchFormModal';
import { ApiError } from '@aquaculture/shared-ui';
import { useAuth } from '@aquaculture/shared-ui';

// Status badge colors
const statusColors: Record<BatchStatus, string> = {
  QUARANTINE: 'bg-yellow-100 text-yellow-800',
  ACTIVE: 'bg-green-100 text-green-800',
  GROWING: 'bg-blue-100 text-blue-800',
  PRE_HARVEST: 'bg-purple-100 text-purple-800',
  HARVESTING: 'bg-orange-100 text-orange-800',
  HARVESTED: 'bg-gray-100 text-gray-800',
  TRANSFERRED: 'bg-indigo-100 text-indigo-800',
  FAILED: 'bg-red-100 text-red-800',
  CLOSED: 'bg-gray-100 text-gray-600',
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

  // Fetch batches from API
  const { data: batchData, isLoading, error, refetch } = useBatchList(
    {
      status: statusFilter !== 'all' ? [statusFilter] : undefined,
      searchTerm: searchTerm || undefined,
    },
    {
      page: 1,
      limit: 50,
      sortBy: 'stockedAt',
      sortOrder: 'DESC',
    }
  );

  const batches = batchData?.items || [];

  // Filter batches (additional client-side filtering if needed)
  const filteredBatches = useMemo(() => {
    return batches.filter(batch => {
      const matchesSearch = !searchTerm ||
        batch.batchNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
        batch.name?.toLowerCase().includes(searchTerm.toLowerCase());

      return matchesSearch;
    });
  }, [batches, searchTerm]);

  // Calculate survival rate
  const getSurvivalRate = (batch: Batch): number => {
    if (batch.survivalRate !== undefined) return batch.survivalRate;
    if (batch.initialQuantity <= 0) return 100;
    return ((batch.initialQuantity - batch.totalMortality) / batch.initialQuantity) * 100;
  };

  // Get current biomass
  const getCurrentBiomass = (batch: Batch): number => {
    if (batch.currentBiomassKg !== undefined) return batch.currentBiomassKg;
    return batch.weight?.actual?.totalBiomass || batch.weight?.theoretical?.totalBiomass || 0;
  };

  // Format date
  const formatDate = (date: string): string => {
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  // Calculate summary stats
  const summaryStats = useMemo(() => {
    const activeBatches = batches.filter(b => b.isActive);
    const totalStock = batches.reduce((sum, b) => sum + b.currentQuantity, 0);
    const totalBiomass = batches.reduce((sum, b) => sum + getCurrentBiomass(b), 0);
    const avgFCR = batches.length > 0
      ? batches.reduce((sum, b) => sum + (b.fcr?.actual || 0), 0) / batches.length
      : 0;

    return {
      activeBatches: activeBatches.length,
      totalStock,
      totalBiomass,
      avgFCR,
    };
  }, [batches]);

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
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm pl-10"
            />
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
              <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
          </div>

          {/* Status Filter */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as BatchStatus | 'all')}
            className="block rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
          >
            <option value="all">All Status</option>
            {Object.entries(statusLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>

        {/* Add Button */}
        <button
          onClick={() => setShowAddModal(true)}
          className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
        >
          <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Batch
        </button>
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
        <div className="bg-white shadow rounded-lg p-8">
          <div className="flex flex-col items-center justify-center">
            <svg className="animate-spin h-8 w-8 text-blue-600 mb-4" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
            <p className="text-gray-500">Loading batches...</p>
          </div>
        </div>
      )}

      {/* Batch Table */}
      {!isLoading && !error && (
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Batch
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Species
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Quantity
                </th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Biomass (kg)
                </th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Survival
                </th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  FCR
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Stocked
                </th>
                <th scope="col" className="relative px-6 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredBatches.map((batch) => (
                <tr
                  key={batch.id}
                  className="hover:bg-gray-50 cursor-pointer"
                  onClick={() => navigate(`/sites/batch/${batch.id}`)}
                >
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      <div>
                        <div className="text-sm font-medium text-gray-900">{batch.batchNumber}</div>
                        {batch.name && (
                          <div className="text-sm text-gray-500">{batch.name}</div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-gray-900">{batch.speciesId}</div>
                    <div className="text-sm text-gray-500 capitalize">{batch.inputType.replace('_', ' ')}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[batch.status]}`}>
                      {statusLabels[batch.status]}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right">
                    <div className="text-sm text-gray-900">{batch.currentQuantity.toLocaleString()}</div>
                    <div className="text-sm text-gray-500">/ {batch.initialQuantity.toLocaleString()}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right">
                    <div className="text-sm text-gray-900">{getCurrentBiomass(batch).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right">
                    <div className={`text-sm font-medium ${getSurvivalRate(batch) >= 95 ? 'text-green-600' : getSurvivalRate(batch) >= 90 ? 'text-yellow-600' : 'text-red-600'}`}>
                      {getSurvivalRate(batch).toFixed(1)}%
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right">
                    <div className={`text-sm font-medium ${(batch.fcr?.actual || 0) <= (batch.fcr?.target || 1.5) ? 'text-green-600' : 'text-red-600'}`}>
                      {batch.fcr?.actual?.toFixed(2) || '-'}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {formatDate(batch.stockedAt)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        // TODO: Open allocation modal
                      }}
                      className="text-blue-600 hover:text-blue-900 mr-3"
                      title="Allocate to Tank"
                    >
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                      </svg>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        // TODO: Open edit modal
                      }}
                      className="text-gray-600 hover:text-gray-900"
                      title="Edit"
                    >
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {filteredBatches.length === 0 && (
            <div className="text-center py-12">
              <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              <h3 className="mt-2 text-sm font-medium text-gray-900">No batches found</h3>
              <p className="mt-1 text-sm text-gray-500">
                Get started by creating a new batch.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <div className="p-3 bg-blue-100 rounded-lg">
                <svg className="w-6 h-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              </div>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Active Batches</p>
              <p className="text-2xl font-semibold text-gray-900">
                {summaryStats.activeBatches}
              </p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <div className="p-3 bg-green-100 rounded-lg">
                <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
              </div>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Total Stock</p>
              <p className="text-2xl font-semibold text-gray-900">
                {summaryStats.totalStock.toLocaleString()}
              </p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <div className="p-3 bg-purple-100 rounded-lg">
                <svg className="w-6 h-6 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
                </svg>
              </div>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Total Biomass</p>
              <p className="text-2xl font-semibold text-gray-900">
                {summaryStats.totalBiomass.toLocaleString(undefined, { maximumFractionDigits: 0 })} kg
              </p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <div className="p-3 bg-yellow-100 rounded-lg">
                <svg className="w-6 h-6 text-yellow-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Avg. FCR</p>
              <p className="text-2xl font-semibold text-gray-900">
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
