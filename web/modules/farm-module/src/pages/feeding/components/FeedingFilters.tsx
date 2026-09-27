/**
 * Feeding Filters Component
 *
 * Shared site/batch filter used across all feeding tabs.
 * Extracted to avoid duplication between FeedingPage tabs.
 */
import React from 'react';
import { Select } from '@aquaculture/shared-ui';

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
    <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Site Filter */}
        <div>
          <Select
            label="Site"
            value={selectedSiteId}
            onChange={(e) => {
              onSiteChange(e.target.value);
              onBatchChange('');
            }}
            disabled={sitesLoading}
            options={[
              { value: '', label: 'All Sites' },
              ...sites.map((site) => ({
                value: site.id,
                label: `${site.name} (${site.code})`,
              })),
            ]}
          />
        </div>

        {/* Batch Filter */}
        <div>
          <Select
            label="Batch"
            value={selectedBatchId}
            onChange={(e) => onBatchChange(e.target.value)}
            disabled={batchesLoading}
            options={[
              { value: '', label: 'All Batches' },
              ...batches.map((batch) => ({
                value: batch.id,
                label: `${batch.batchNumber} - ${batch.name || 'Unnamed'}`,
              })),
            ]}
          />
        </div>
      </div>
    </div>
  );
};
