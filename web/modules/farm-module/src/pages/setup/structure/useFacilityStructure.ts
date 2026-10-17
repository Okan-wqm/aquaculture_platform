/**
 * Structural levels of the facility tree (sites › departments › systems).
 *
 * WHY: the structure page reuses the queries the Sites, Departments and
 * Systems tabs already run — same hooks, same tenant-scoped cache entries — so
 * an edit in a tab and the tree never disagree. Equipment is NOT loaded here:
 * a tenant's equipment outgrows one page quickly, so each department/system
 * loads its own rows when it is opened (useNodeEquipment).
 *
 * WHAT: the derived tree, one loading/error state for the three queries, and
 * the lists that came back capped at one page (departments and systems load
 * page 1 of 100), so the page can say so instead of silently dropping records.
 */
import { useMemo } from 'react';

import { useDepartmentList } from '../../../hooks/useDepartments';
import { useSiteList } from '../../../hooks/useSites';
import { useSystemList } from '../../../hooks/useSystems';

import { buildFacilityTree, type FacilityTree } from './facilityTree';

export interface CappedList {
  kind: 'department' | 'system';
  shown: number;
  total: number;
}

export interface FacilityStructureState {
  tree: FacilityTree;
  isLoading: boolean;
  isError: boolean;
  capped: CappedList[];
}

export function useFacilityStructure(): FacilityStructureState {
  const sitesQuery = useSiteList();
  const departmentsQuery = useDepartmentList();
  const systemsQuery = useSystemList();

  const sites = sitesQuery.data?.items;
  const departments = departmentsQuery.data;
  const systems = systemsQuery.data;

  const tree = useMemo(
    () => buildFacilityTree(sites ?? [], departments?.items ?? [], systems?.items ?? []),
    [sites, departments, systems],
  );

  const capped: CappedList[] = [];
  if (departments && departments.total > departments.items.length) {
    capped.push({ kind: 'department', shown: departments.items.length, total: departments.total });
  }
  if (systems && systems.total > systems.items.length) {
    capped.push({ kind: 'system', shown: systems.items.length, total: systems.total });
  }

  return {
    tree,
    isLoading: sitesQuery.isLoading || departmentsQuery.isLoading || systemsQuery.isLoading,
    isError: sitesQuery.isError || departmentsQuery.isError || systemsQuery.isError,
    capped,
  };
}
