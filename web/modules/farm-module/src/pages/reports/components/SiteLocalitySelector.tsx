/**
 * SiteLocalitySelector — the shared locality picker for regulatory report tabs
 * (FARM-HIGH-128). Renders only when the tenant has more than one configured
 * site→locality mapping and the tab was not pinned to a specific site; a single
 * mapping needs no picker (the effective site defaults to it).
 */
import React from 'react';
import { Select } from '@aquaculture/shared-ui';
import type { SiteLocalityMapping } from '../hooks/useEffectiveReportSite';

export interface SiteLocalitySelectorProps {
  siteMappings: SiteLocalityMapping[];
  effectiveSiteId?: string;
  onChange: (siteId: string | undefined) => void;
  show: boolean;
}

export const SiteLocalitySelector: React.FC<SiteLocalitySelectorProps> = ({
  siteMappings,
  effectiveSiteId,
  onChange,
  show,
}) => {
  if (!show) return null;
  return (
    <Select
      aria-label="Site"
      fullWidth={false}
      size="sm"
      value={effectiveSiteId ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
      options={siteMappings.map((m) => ({
        value: m.siteId,
        label: m.siteName ?? `Lokalitet ${m.lokalitetsnummer}`,
      }))}
    />
  );
};

export default SiteLocalitySelector;
