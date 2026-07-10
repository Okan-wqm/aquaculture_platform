/**
 * Sites hooks for farm-module
 * Handles CRUD operations for sites via GraphQL API
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useAuth,
  graphqlClient,
  createTenantQueryKey,
  createTenantInvalidationKey,
} from '@aquaculture/shared-ui';

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
  /** Norwegian locality number (Akvakulturregisteret) — regulatory reports fail closed without it. */
  lokalitetsnummer?: number;
  organisationNumberOverride?: string;
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
  lokalitetsnummer?: number;
  organisationNumberOverride?: string;
  type?: string;
  status?: string;
  description?: string;
  location?: { latitude: number; longitude: number; altitude?: number };
  address?: {
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
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
  query Sites($filter: SiteFilterInput, $pagination: FarmPaginationInput) {
    sites(filter: $filter, pagination: $pagination) {
      items {
        id
        name
        code
        lokalitetsnummer
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
      lokalitetsnummer
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
      lokalitetsnummer
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
      lokalitetsnummer
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
        lokalitetsnummer
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
    queryKey: createTenantQueryKey(tenantId, 'sites', 'list', tenantId, filter),
    queryFn: async () => {
      const data = await graphqlClient.request<{ sites: PaginatedResponse }>(SITES_LIST_QUERY, {
        filter,
        pagination: { page: 1, limit: 100 },
      });
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
    queryKey: createTenantQueryKey(tenantId, 'sites', 'detail', tenantId, id),
    queryFn: async () => {
      const data = await graphqlClient.request<{ site: Site }>(SITE_QUERY, { id });
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
      const data = await graphqlClient.request<{ createSite: Site }>(CREATE_SITE_MUTATION, {
        input,
      });
      return data.createSite;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, 'sites', 'list'),
      });
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
      const data = await graphqlClient.request<{ updateSite: Site }>(UPDATE_SITE_MUTATION, {
        input,
      });
      return data.updateSite;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, 'sites', 'list'),
      });
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, 'sites', 'detail', variables.id),
      });
    },
  });
}

// Delete Preview Types
export interface SiteDeletePreviewResult {
  site: { id: string; name: string; code: string };
  canDelete: boolean;
  blockers: string[];
  affectedItems: {
    departments: Array<{
      id: string;
      name: string;
      code: string;
      equipmentCount: number;
      tankCount: number;
    }>;
    systems: Array<{ id: string; name: string; code: string; equipmentCount: number }>;
    equipment: Array<{ id: string; name: string; code: string; status: string }>;
    tanks: Array<{
      id: string;
      name: string;
      code: string;
      currentBiomass: number;
      hasActiveBiomass: boolean;
    }>;
    totalCount: number;
  };
}

/**
 * Hook to get site delete preview
 */
export function useSiteDeletePreview(id: string | null) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'sites', 'deletePreview', tenantId, id),
    queryFn: async () => {
      const data = await graphqlClient.request<{ siteDeletePreview: SiteDeletePreviewResult }>(
        SITE_DELETE_PREVIEW_QUERY,
        { id },
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
      const data = await graphqlClient.request<{ deleteSite: boolean }>(DELETE_SITE_MUTATION, {
        id,
        cascade,
      });
      return data.deleteSite;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, 'sites', 'list'),
      });
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, 'departments', 'list'),
      });
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, 'systems', 'list'),
      });
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, 'equipment', 'list'),
      });
    },
  });
}

// =============================================================================
// SITE CONTACTS — frontend wiring for upsertSiteContacts mutation
// (Scope A Phase 4.4.3, backend shipped in PR #149).
// =============================================================================
//
// The backend exposes:
//   query   siteContacts(siteId: ID!): [SiteContactResponse!]!
//   mutation upsertSiteContacts(siteId: ID!, contacts: [SiteContactInput!]!): [SiteContactResponse!]!
//
// Mutation semantics: REPLACE the full contact list for a site (DELETE+
// INSERT in one transaction + outbox event). Empty `contacts` clears
// all contacts. At most one entry may carry `isPrimary=true` — backend
// enforces via partial unique index AND a handler-level pre-check for
// clearer error messages.
//
// Frontend usage flow:
//   1. Open SiteFormModal in edit mode (siteId is set).
//   2. `useSiteContacts(siteId)` populates the existing contact rows.
//   3. Operator edits in-modal; on submit, `useUpsertSiteContacts()`
//      ships the full new list. Cache invalidation refreshes the
//      query so the modal sees the post-write state on next open.

export interface SiteContact {
  id: string;
  tenantId: string;
  siteId: string;
  name: string;
  role?: string;
  email?: string;
  phone?: string;
  isPrimary: boolean;
  createdAt: string;
  createdBy?: string;
}

/**
 * Input shape for one row in `upsertSiteContacts` — mirror of the
 * backend `SiteContactInput` GraphQL type. `id` is INTENTIONALLY
 * absent on the input shape: upsert is replace-semantics, the
 * server mints fresh ids on the new rows and the previous rows
 * are deleted in the same transaction. (Future-proofing tip: if
 * we add per-row update semantics later, that's a NEW mutation
 * `updateSiteContact(id, ...)`, not a shape mutation here — keep
 * the input deliberately narrow.)
 */
export interface SiteContactInput {
  name: string;
  role?: string;
  email?: string;
  phone?: string;
  isPrimary?: boolean;
}

const SITE_CONTACTS_QUERY = `
  query SiteContacts($siteId: ID!) {
    siteContacts(siteId: $siteId) {
      id
      tenantId
      siteId
      name
      role
      email
      phone
      isPrimary
      createdAt
      createdBy
    }
  }
`;

const UPSERT_SITE_CONTACTS_MUTATION = `
  mutation UpsertSiteContacts($siteId: ID!, $contacts: [SiteContactInput!]!) {
    upsertSiteContacts(siteId: $siteId, contacts: $contacts) {
      id
      tenantId
      siteId
      name
      role
      email
      phone
      isPrimary
      createdAt
      createdBy
    }
  }
`;

/**
 * Fetch all contact rows for a site, primary first, then chronological.
 * `enabled` gate: query is skipped when `siteId` is undefined (the
 * SiteFormModal in CREATE mode has no siteId yet, so there's nothing
 * to load).
 */
export function useSiteContacts(siteId: string | undefined) {
  const { token, tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'sites', 'contacts', siteId ?? ''),
    queryFn: async () => {
      if (!siteId) return [] as SiteContact[];
      const data = await graphqlClient.request<{ siteContacts: SiteContact[] }>(
        SITE_CONTACTS_QUERY,
        { siteId },
      );
      return data.siteContacts;
    },
    enabled: !!token && !!tenantId && !!siteId,
    staleTime: 60_000,
  });
}

/**
 * Replace the FULL contact list for one site. Server-side this is one
 * transactional swap + a `SiteContactsChanged` outbox event.
 *
 * Cache invalidation invalidates BOTH the per-site contacts query
 * (the modal's read view) AND the sites list (in case the list view
 * grows a "primary contact name" column in the future).
 */
export function useUpsertSiteContacts() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (vars: { siteId: string; contacts: SiteContactInput[] }) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ upsertSiteContacts: SiteContact[] }>(
        UPSERT_SITE_CONTACTS_MUTATION,
        vars,
      );
      return data.upsertSiteContacts;
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, 'sites', 'contacts', vars.siteId),
      });
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, 'sites', 'list'),
      });
    },
  });
}
