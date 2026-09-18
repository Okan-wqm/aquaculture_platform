/**
 * Feeding Filters Component
 *
 * Shared site/batch filter used across all feeding tabs.
 * Extracted to avoid duplication between FeedingPage tabs.
 */
import React from 'react';

interface Site {
  id: string;
  name: string;
  code: string;
}

interface Batch {
  id: string;
  batchNumber: string;
  name?: string;
}

interface FeedingFiltersProps {
  selectedSiteId: string;
  selectedBatchId: string;
  onSiteChange: (siteId: string) => void;
  onBatchChange: (batchId: string) => void;
  sites: readonly Site[];
  batches: readonly Batch[];
  sitesLoading: boolean;
  batchesLoading: boolean;
}

export const FeedingFilters: React.FC<FeedingFiltersProps> = ({
  selectedSiteId,
  selectedBatchId,
  onSiteChange,
  onBatchChange,
  sites,
  batches,
  sitesLoading,
  batchesLoading,
}) => {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Site Filter */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Site
          </label>
          <select
            value={selectedSiteId}
            onChange={(e) => {
              onSiteChange(e.target.value);
              onBatchChange('');
            }}
            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            disabled={sitesLoading}
          >
            <option value="">All Sites</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name} ({site.code})
              </option>
            ))}
          </select>
        </div>

        {/* Batch Filter */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Batch
          </label>
          <select
            value={selectedBatchId}
            onChange={(e) => onBatchChange(e.target.value)}
            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            disabled={batchesLoading}
          >
            <option value="">All Batches</option>
            {batches.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batch.batchNumber} - {batch.name || 'Unnamed'}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
};
