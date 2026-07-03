/**
 * SiteLocalitySelector — the shared locality picker for regulatory report tabs
 * (FARM-HIGH-128). Renders only when the tenant has more than one configured
 * site→locality mapping and the tab was not pinned to a specific site; a single
 * mapping needs no picker (the effective site defaults to it).
 */
import React from 'react';
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
    <select
      value={effectiveSiteId ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
      className="px-3 py-2 border border-gray-300 rounded-md text-sm text-gray-700 bg-white"
      aria-label="Site"
    >
      {siteMappings.map((m) => (
        <option key={m.siteId} value={m.siteId}>
          {m.siteName ?? `Lokalitet ${m.lokalitetsnummer}`}
        </option>
      ))}
    </select>
  );
};

export default SiteLocalitySelector;
