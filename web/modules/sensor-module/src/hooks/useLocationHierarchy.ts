/**
 * Location Hierarchy hooks for sensor-module
 * Fetches Sites, Departments, Systems from farm-service GraphQL API
 */

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@aquaculture/shared-ui';

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
  query Sites($filter: SiteFilterInput, $pagination: PaginationInput) {
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

// GraphQL fetch helper
async function graphqlFetch<T>(
  query: string,
  variables: Record<string, unknown>,
  token?: string
): Promise<T> {
  const response = await fetch('/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  if (result.errors) {
    throw new Error(result.errors[0]?.message || 'GraphQL Error');
  }

  return result.data;
}

/**
 * Hook to fetch sites list
 */
export function useSiteList(filter?: { isActive?: boolean; status?: string }) {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['sites', 'list', filter],
    queryFn: async () => {
      const data = await graphqlFetch<{ sites: PaginatedSiteResponse }>(
        SITES_LIST_QUERY,
        { filter },
        token
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
    queryKey: ['departments', 'bySite', siteId],
    queryFn: async () => {
      const data = await graphqlFetch<{ departmentsBySite: Department[] }>(
        DEPARTMENTS_BY_SITE_QUERY,
        { siteId },
        token
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

  return useQuery({
    queryKey: ['systems', 'byDepartment', departmentId],
    queryFn: async () => {
      const data = await graphqlFetch<{ systemsByDepartment: System[] }>(
        SYSTEMS_BY_DEPARTMENT_QUERY,
        { departmentId },
        token
      );
      return data.systemsByDepartment;
    },
    staleTime: 30000,
    enabled: !!token && !!departmentId,
  });
}
