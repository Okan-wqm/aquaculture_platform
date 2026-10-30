/**
 * Location Hierarchy hooks for sensor-module
 * Fetches Sites, Departments, Systems from farm-service GraphQL API
 */

import { useQuery } from '@tanstack/react-query';
import { useAuth, createTenantQueryKey } from '@aquaculture/shared-ui';
import { graphqlFetch } from '../config/api';

// Types
export interface Site {
  id: string;
  name: string;
  code: string;
  type: string;
  status: string;
  description?: string;
  isActive: boolean;
}

export interface Department {
  id: string;
  name: string;
  code: string;
  type: string;
  status: string;
  siteId: string;
  description?: string;
  isActive: boolean;
}

export interface System {
  id: string;
  name: string;
  code: string;
  type: string;
  status: string;
  siteId: string;
  departmentId?: string;
  description?: string;
  isActive: boolean;
}

interface PaginatedSiteResponse {
  items: Site[];
  total: number;
  page: number;
  limit: number;
}

// GraphQL queries
const SITES_LIST_QUERY = `
  query Sites($filter: SiteFilterInput, $pagination: FarmPaginationInput) {
    sites(filter: $filter, pagination: $pagination) {
      items {
        id
        name
        code
        type
        status
        description
        isActive
      }
      total
      page
      limit
    }
  }
`;

const DEPARTMENTS_BY_SITE_QUERY = `
  query DepartmentsBySite($siteId: ID!) {
    departmentsBySite(siteId: $siteId) {
      id
      name
      code
      type
      status
      siteId
      description
      isActive
    }
  }
`;

const SYSTEMS_BY_SITE_QUERY = `
  query SystemsBySite($filter: SystemFilterInput, $pagination: FarmPaginationInput) {
    systems(filter: $filter, pagination: $pagination) {
      items {
        id
        name
        code
        type
        status
        siteId
        departmentId
        description
        isActive
      }
    }
  }
`;

const SITE_NAME_QUERY = `
  query SiteName($id: ID!) {
    site(id: $id) {
      id
      name
    }
  }
`;

const DEPARTMENT_NAME_QUERY = `
  query DepartmentName($id: ID!) {
    department(id: $id) {
      id
      name
    }
  }
`;

const SYSTEM_NAME_QUERY = `
  query SystemName($id: ID!) {
    system(id: $id) {
      id
      name
    }
  }
`;

/** The most rows farm returns on one page; a picker asks for all of them. */
const FARM_PAGE_LIMIT = 100;

/** A level of the topology named by id, for showing a stored place by name. */
export interface NamedLevel {
  id: string;
  name: string;
}

/**
 * Hook to fetch sites list: farm's largest page, so a picker lists every site
 * a tenant can have before paging matters.
 */
export function useSiteList(filter?: { isActive?: boolean; status?: string }) {
  const { token } = useAuth();

  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'sites', 'list', filter, FARM_PAGE_LIMIT),
    queryFn: async () => {
      const data = await graphqlFetch<{ sites: PaginatedSiteResponse }>(
        SITES_LIST_QUERY,
        { filter, pagination: { page: 1, limit: FARM_PAGE_LIMIT } },
      );
      return data.sites;
    },
    staleTime: 30000,
    enabled: !!token,
  });
}

/**
 * Hook to fetch departments by site
 */
export function useDepartmentsBySite(siteId: string) {
  const { tenantId } = useAuth();
  const { token } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'departments', 'bySite', siteId),
    queryFn: async () => {
      const data = await graphqlFetch<{ departmentsBySite: Department[] }>(
        DEPARTMENTS_BY_SITE_QUERY,
        { siteId },
      );
      return data.departmentsBySite;
    },
    staleTime: 30000,
    enabled: !!token && !!siteId,
  });
}

/**
 * A site's live systems, those of every department and the site-wide ones
 * (no department) alike: farm places a device in either kind, so a picker
 * narrows them to a department itself.
 */
export function useSystemsBySite(siteId: string) {
  const { token, tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'systems', 'bySite', siteId, FARM_PAGE_LIMIT),
    queryFn: async () => {
      const data = await graphqlFetch<{ systems: { items: System[] } }>(SYSTEMS_BY_SITE_QUERY, {
        filter: { siteId, isActive: true },
        pagination: { page: 1, limit: FARM_PAGE_LIMIT },
      });
      return data.systems.items;
    },
    staleTime: 30000,
    enabled: !!token && !!siteId,
  });
}

function useNamedLevel(
  level: 'site' | 'department' | 'system',
  query: string,
  id: string | undefined,
) {
  const { token, tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, level, 'name', id),
    queryFn: async () => {
      const data = await graphqlFetch<Record<typeof level, NamedLevel>>(query, { id });
      return data[level];
    },
    staleTime: 30000,
    enabled: !!token && !!id,
  });
}

/** One site's name by id — inactive or not, a stored place still reads by name. */
export function useSiteName(id: string | undefined) {
  return useNamedLevel('site', SITE_NAME_QUERY, id);
}

/** One department's name by id. */
export function useDepartmentName(id: string | undefined) {
  return useNamedLevel('department', DEPARTMENT_NAME_QUERY, id);
}

/** One system's name by id. */
export function useSystemName(id: string | undefined) {
  return useNamedLevel('system', SYSTEM_NAME_QUERY, id);
}
