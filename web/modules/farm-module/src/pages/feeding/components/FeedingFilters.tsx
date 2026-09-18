/**
 * Feeding Filters Component
 *
 * Shared site/batch filter used across all feeding tabs.
 * Extracted to avoid duplication between FeedingPage tabs.
 * SUDERRA restyle — sd-select primitives from the shell stylesheet; props
 * and reset-on-site-change behavior unchanged.
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

const fieldLabelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11.5,
  fontWeight: 700,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: '#5c7783',
  marginBottom: 6,
};

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
    <div className="sd-card sd-toolbar" style={{ padding: '13px 15px' }}>
      {/* Site Filter */}
      <div style={{ flex: '1 1 240px', minWidth: 0 }}>
        <label style={fieldLabelStyle} htmlFor="feeding-site-filter">Site</label>
        <select
          id="feeding-site-filter"
          value={selectedSiteId}
          onChange={(e) => {
            onSiteChange(e.target.value);
            onBatchChange('');
          }}
          className="sd-select"
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
      <div style={{ flex: '1 1 240px', minWidth: 0 }}>
        <label style={fieldLabelStyle} htmlFor="feeding-batch-filter">Batch</label>
        <select
          id="feeding-batch-filter"
          value={selectedBatchId}
          onChange={(e) => onBatchChange(e.target.value)}
          className="sd-select"
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
  );
};
