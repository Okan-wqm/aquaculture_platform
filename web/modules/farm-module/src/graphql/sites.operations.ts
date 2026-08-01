/**
 * Sites GraphQL Operations
 *
 * All GraphQL queries and mutations for site setup management. Maps to the
 * backend site.resolver.ts operations (create/update/delete write through the
 * tenant-transaction + audit + outbox contract — FARM-HIGH-003 Phase 3).
 *
 * Extracted from hooks/useSites.ts as part of FARM-HIGH-003 Phase 5 (frontend
 * & API replacement): setup GraphQL lives in graphql/**, hooks consume the
 * named operations via useTenantQuery / useTenantMutation. No raw operation
 * strings remain in the hooks/pages.
 *
 * @module FarmModule/GraphQL
 */

// ============================================================================
// FRAGMENTS
// ============================================================================

/** Full site field set shared by the list and single-site reads. */
const SITE_FIELDS = `
  id
  name
  code
  lokalitetsnummer
  organisationNumberOverride
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
  monitoringRadiusM
  monitoringArea
  monitoringLocationRevision
  siteManager
  contactEmail
  contactPhone
  isActive
  createdAt
  updatedAt
`;

/** Site contact row fields (mirror the backend SiteContactResponse type). */
const SITE_CONTACT_FIELDS = `
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
`;

// ============================================================================
// QUERIES
// ============================================================================

export const SITES_LIST_QUERY = `
  query Sites($filter: SiteFilterInput, $pagination: FarmPaginationInput) {
    sites(filter: $filter, pagination: $pagination) {
      items {
        ${SITE_FIELDS}
      }
      total
      page
      limit
    }
  }
`;

export const SITE_QUERY = `
  query Site($id: ID!) {
    site(id: $id) {
      ${SITE_FIELDS}
    }
  }
`;

export const SITE_DELETE_PREVIEW_QUERY = `
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

export const SITE_CONTACTS_QUERY = `
  query SiteContacts($siteId: ID!) {
    siteContacts(siteId: $siteId) {
      ${SITE_CONTACT_FIELDS}
    }
  }
`;

// ============================================================================
// MUTATIONS
// ============================================================================

export const CREATE_SITE_MUTATION = `
  mutation CreateSite($input: CreateSiteInput!) {
    createSite(input: $input) {
      ${SITE_FIELDS}
    }
  }
`;

export const UPDATE_SITE_MUTATION = `
  mutation UpdateSite($input: UpdateSiteInput!) {
    updateSite(input: $input) {
      ${SITE_FIELDS}
    }
  }
`;

export const DELETE_SITE_MUTATION = `
  mutation DeleteSite($id: ID!, $cascade: Boolean!) {
    deleteSite(id: $id, cascade: $cascade)
  }
`;

export const UPSERT_SITE_CONTACTS_MUTATION = `
  mutation UpsertSiteContacts($siteId: ID!, $contacts: [SiteContactInput!]!) {
    upsertSiteContacts(siteId: $siteId, contacts: $contacts) {
      ${SITE_CONTACT_FIELDS}
    }
  }
`;
