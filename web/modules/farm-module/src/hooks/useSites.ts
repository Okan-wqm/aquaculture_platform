/**
 * Sites hooks for farm-module
 * Handles CRUD operations for sites via GraphQL API
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient } from '@aquaculture/shared-ui';

// Types
export interface SiteLocation {
  latitude: number;
  longitude: number;
  altitude?: number;
}

export interface SiteAddress {
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface Site {
  id: string;
  name: string;
  code: string;
  type: string;
  status: string;
  description?: string;
  location?: SiteLocation;
  address?: SiteAddress;
  country?: string;
  region?: string;
  timezone?: string;
  totalArea?: number;
  siteManager?: string;
  contactEmail?: string;
  contactPhone?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSiteInput {
  name: string;
  code: string;
  type?: string;
  status?: string;
  description?: string;
  location?: { latitude: number; longitude: number; altitude?: number };
  address?: { street?: string; city?: string; state?: string; postalCode?: string; country?: string };
  country?: string;
  region?: string;
  timezone?: string;
  totalArea?: number;
  siteManager?: string;
  contactEmail?: string;
  contactPhone?: string;
}

export interface UpdateSiteInput extends Partial<CreateSiteInput> {
  id: string;
  isActive?: boolean;
}

interface PaginatedResponse {
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
        location {
          latitude
          longitude
          altitude
        }
        address {
          street
          city
          state
          postalCode
          country
        }
        country
        region
        timezone
        totalArea
        siteManager
        contactEmail
        contactPhone
        isActive
        createdAt
        updatedAt
      }
      total
      page
      limit
    }
  }
`;

const SITE_QUERY = `
  query Site($id: ID!) {
    site(id: $id) {
      id
      name
      code
      type
      status
      description
      location {
        latitude
        longitude
        altitude
      }
      address {
        street
        city
        state
        postalCode
        country
      }
      country
      region
      timezone
      totalArea
      siteManager
      contactEmail
      contactPhone
      isActive
      createdAt
      updatedAt
    }
  }
`;

const CREATE_SITE_MUTATION = `
  mutation CreateSite($input: CreateSiteInput!) {
    createSite(input: $input) {
      id
      name
      code
      status
      isActive
    }
  }
`;

const UPDATE_SITE_MUTATION = `
  mutation UpdateSite($input: UpdateSiteInput!) {
    updateSite(input: $input) {
      id
      name
      code
      status
      isActive
    }
  }
`;

const DELETE_SITE_MUTATION = `
  mutation DeleteSite($id: ID!, $cascade: Boolean!) {
    deleteSite(id: $id, cascade: $cascade)
  }
`;

const SITE_DELETE_PREVIEW_QUERY = `
  query SiteDeletePreview($id: ID!) {
    siteDeletePreview(id: $id) {
      site {
        id
        name
        code
      }
      canDelete
      blockers
      affectedItems {
        departments {
          id
          name
          code
          equipmentCount
          tankCount
        }
        systems {
          id
          name
          code
          equipmentCount
        }
        equipment {
          id
          name
          code
          status
        }
        tanks {
          id
          name
          code
          currentBiomass
          hasActiveBiomass
        }
        totalCount
      }
    }
  }
`;

// graphqlClient from shared-ui handles token/tenantId automatically

/**
 * Hook to fetch sites list
 */
export function useSiteList(filter?: {
  status?: string;
  isActive?: boolean;
  country?: string;
  region?: string;
  search?: string;
}) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['sites', 'list', filter],
    queryFn: async () => {
      const data = await graphqlClient.request<{ sites: PaginatedResponse }>(
        SITES_LIST_QUERY,
        { filter }
      );
      return data.sites;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId,
  });
}

/**
 * Hook to fetch single site
 */
export function useSite(id: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['sites', 'detail', id],
    queryFn: async () => {
      const data = await graphqlClient.request<{ site: Site }>(
        SITE_QUERY,
        { id }
      );
      return data.site;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!id,
  });
}

/**
 * Hook to create site
 */
export function useCreateSite() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateSiteInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ createSite: Site }>(
        CREATE_SITE_MUTATION,
        { input }
      );
      return data.createSite;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sites', 'list'] });
    },
  });
}

/**
 * Hook to update site
 */
export function useUpdateSite() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateSiteInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ updateSite: Site }>(
        UPDATE_SITE_MUTATION,
        { input }
      );
      return data.updateSite;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['sites', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['sites', 'detail', variables.id] });
    },
  });
}

// Delete Preview Types
export interface SiteDeletePreviewResult {
  site: { id: string; name: string; code: string };
  canDelete: boolean;
  blockers: string[];
  affectedItems: {
    departments: Array<{ id: string; name: string; code: string; equipmentCount: number; tankCount: number }>;
    systems: Array<{ id: string; name: string; code: string; equipmentCount: number }>;
    equipment: Array<{ id: string; name: string; code: string; status: string }>;
    tanks: Array<{ id: string; name: string; code: string; currentBiomass: number; hasActiveBiomass: boolean }>;
    totalCount: number;
  };
}

/**
 * Hook to get site delete preview
 */
export function useSiteDeletePreview(id: string | null) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['sites', 'deletePreview', id],
    queryFn: async () => {
      const data = await graphqlClient.request<{ siteDeletePreview: SiteDeletePreviewResult }>(
        SITE_DELETE_PREVIEW_QUERY,
        { id }
      );
      return data.siteDeletePreview;
    },
    staleTime: 0, // Always fetch fresh data for delete preview
    enabled: !!token && !!tenantId && !!id,
  });
}

/**
 * Hook to delete site
 * @param cascade - If true, cascade delete all related items
 */
export function useDeleteSite() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, cascade = false }: { id: string; cascade?: boolean }) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ deleteSite: boolean }>(
        DELETE_SITE_MUTATION,
        { id, cascade }
      );
      return data.deleteSite;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sites', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['departments', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['systems', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['equipment', 'list'] });
    },
  });
}
