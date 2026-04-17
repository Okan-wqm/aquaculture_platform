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

const SYSTEMS_BY_DEPARTMENT_QUERY = `
  query SystemsByDepartment($departmentId: ID!) {
    systemsByDepartment(departmentId: $departmentId) {
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
`;

/**
 * Hook to fetch sites list
 */
export function useSiteList(filter?: { isActive?: boolean; status?: string }) {
  const { token } = useAuth();

  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'sites', 'list', filter),
    queryFn: async () => {
      const data = await graphqlFetch<{ sites: PaginatedSiteResponse }>(
        SITES_LIST_QUERY,
        { filter },
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
 * Hook to fetch systems by department
 */
export function useSystemsByDepartment(departmentId: string) {
  const { token } = useAuth();

  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'systems', 'byDepartment', departmentId),
    queryFn: async () => {
      const data = await graphqlFetch<{ systemsByDepartment: System[] }>(
        SYSTEMS_BY_DEPARTMENT_QUERY,
        { departmentId },
      );
      return data.systemsByDepartment;
    },
    staleTime: 30000,
    enabled: !!token && !!departmentId,
  });
}
