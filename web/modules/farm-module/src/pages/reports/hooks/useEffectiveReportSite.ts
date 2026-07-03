/**
 * useEffectiveReportSite — the SSoT for resolving which site a regulatory
 * report is being filed for, and the locality selection UI state.
 *
 * WHY (FARM-HIGH-128): Sea-Lice / Smolt / Cleaner-Fish tabs hand-rolled
 * `siteMapping?.lokalitetsnummer || 0` keyed on a siteId prop ReportsPage never
 * passes, so every submission silently carried lokalitetsnummer 0. The correct
 * resolution (already used by Biomass) is: an explicit prop wins, else the
 * operator's selection, else the first configured mapping — and the identity
 * SSoT (buildRegulatoryIdentity) then FAILS CLOSED if the resolved site has no
 * lokalitetsnummer, instead of shipping a 0.
 */
import { useMemo, useState } from 'react';
import { useRegulatorySettings } from '../../../hooks/useRegulatory';

export interface SiteLocalityMapping {
  siteId: string;
  lokalitetsnummer: number;
  siteName?: string;
}

export interface EffectiveReportSite {
  /** The resolved site the report is filed for (undefined only when no mapping is configured). */
  effectiveSiteId?: string;
  /** All configured site→locality mappings, for the selector. */
  siteMappings: SiteLocalityMapping[];
  /** The operator's explicit selection (drives the selector). */
  selectedSiteId?: string;
  setSelectedSiteId: (siteId: string | undefined) => void;
  /** True when more than one mapping exists and a caller-supplied siteId did not pin it. */
  showSelector: boolean;
}

/**
 * @param siteIdProp an explicit site to file for (wins over selection/default).
 */
export function useEffectiveReportSite(siteIdProp?: string): EffectiveReportSite {
  const { data: regulatorySettings } = useRegulatorySettings();
  const [selectedSiteId, setSelectedSiteId] = useState<string | undefined>(undefined);
  const siteMappings = useMemo<SiteLocalityMapping[]>(
    () => regulatorySettings?.siteLocalityMappings ?? [],
    [regulatorySettings?.siteLocalityMappings],
  );
  const effectiveSiteId = siteIdProp ?? selectedSiteId ?? siteMappings[0]?.siteId;
  const showSelector = !siteIdProp && siteMappings.length > 1;
  return { effectiveSiteId, siteMappings, selectedSiteId, setSelectedSiteId, showSelector };
}
