/**
 * Sites hooks for farm-module
 *
 * TanStack Query wrappers over the site setup GraphQL surface. Reads go through
 * useTenantQuery and writes through useTenantMutation — the tenant-key +
 * auth-gate + tenant-scoped invalidation SSoT (FE-CRITICAL-014/015/016). The
 * GraphQL operations live in ../graphql/sites.operations (FARM-HIGH-003 Phase 5:
 * no raw operation strings or hand-rolled invalidation in the hooks).
 */
import {
  graphqlClient,
  useTenantMutation,
  useTenantQuery,
} from '@aquaculture/shared-ui';

import {
  CREATE_SITE_MUTATION,
  DELETE_SITE_MUTATION,
  SITE_CONTACTS_QUERY,
  SITE_DELETE_PREVIEW_QUERY,
  SITE_QUERY,
  SITES_LIST_QUERY,
  UPDATE_SITE_MUTATION,
  UPSERT_SITE_CONTACTS_MUTATION,
} from '../graphql/sites.operations';

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

// ============================================================================
// Query hooks — useTenantQuery adds the tenant prefix + auth gating for us.
// ============================================================================

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
  return useTenantQuery<PaginatedResponse>(
    ['sites', 'list', filter],
    async () => {
      const data = await graphqlClient.request<{ sites: PaginatedResponse }>(SITES_LIST_QUERY, {
        filter,
        pagination: { page: 1, limit: 100 },
      });
      return data.sites;
    },
    { staleTime: 30000 },
  );
}

/**
 * Hook to fetch single site
 */
export function useSite(id: string) {
  return useTenantQuery<Site>(
    ['sites', 'detail', id],
    async () => {
      const data = await graphqlClient.request<{ site: Site }>(SITE_QUERY, { id });
      return data.site;
    },
    { staleTime: 30000, enabled: !!id },
  );
}

// ============================================================================
// Mutation hooks — useTenantMutation invalidates the tenant-scoped prefix on
// success (declare domain segments; the tenant prefix is added).
// ============================================================================

/**
 * Hook to create site
 */
export function useCreateSite() {
  return useTenantMutation(
    async (input: CreateSiteInput) => {
      const data = await graphqlClient.request<{ createSite: Site }>(CREATE_SITE_MUTATION, {
        input,
      });
      return data.createSite;
    },
    { invalidate: [['sites', 'list']] },
  );
}

/**
 * Hook to update site
 */
export function useUpdateSite() {
  return useTenantMutation(
    async (input: UpdateSiteInput) => {
      const data = await graphqlClient.request<{ updateSite: Site }>(UPDATE_SITE_MUTATION, {
        input,
      });
      return data.updateSite;
    },
    { invalidate: [['sites', 'list'], ['sites', 'detail']] },
  );
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
 * Hook to get site delete preview. Always fetches fresh (staleTime 0, no
 * keep-previous) so the operator never acts on a stale blocker list.
 */
export function useSiteDeletePreview(id: string | null) {
  return useTenantQuery<SiteDeletePreviewResult>(
    ['sites', 'deletePreview', id],
    async () => {
      const data = await graphqlClient.request<{ siteDeletePreview: SiteDeletePreviewResult }>(
        SITE_DELETE_PREVIEW_QUERY,
        { id },
      );
      return data.siteDeletePreview;
    },
    { staleTime: 0, keepPreviousData: false, enabled: !!id },
  );
}

/**
 * Hook to delete site
 * @param cascade - If true, cascade delete all related items
 */
export function useDeleteSite() {
  return useTenantMutation(
    async ({ id, cascade = false }: { id: string; cascade?: boolean }) => {
      const data = await graphqlClient.request<{ deleteSite: boolean }>(DELETE_SITE_MUTATION, {
        id,
        cascade,
      });
      return data.deleteSite;
    },
    {
      invalidate: [
        ['sites', 'list'],
        ['departments', 'list'],
        ['systems', 'list'],
        ['equipment', 'list'],
      ],
    },
  );
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

/**
 * Fetch all contact rows for a site, primary first, then chronological.
 * `enabled` gate: query is skipped when `siteId` is undefined (the
 * SiteFormModal in CREATE mode has no siteId yet, so there's nothing
 * to load).
 */
export function useSiteContacts(siteId: string | undefined) {
  return useTenantQuery<SiteContact[]>(
    ['sites', 'contacts', siteId ?? ''],
    async () => {
      if (!siteId) return [] as SiteContact[];
      const data = await graphqlClient.request<{ siteContacts: SiteContact[] }>(
        SITE_CONTACTS_QUERY,
        { siteId },
      );
      return data.siteContacts;
    },
    { enabled: !!siteId, staleTime: 60_000 },
  );
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
  return useTenantMutation(
    async (vars: { siteId: string; contacts: SiteContactInput[] }) => {
      const data = await graphqlClient.request<{ upsertSiteContacts: SiteContact[] }>(
        UPSERT_SITE_CONTACTS_MUTATION,
        vars,
      );
      return data.upsertSiteContacts;
    },
    { invalidate: [['sites', 'contacts'], ['sites', 'list']] },
  );
}
