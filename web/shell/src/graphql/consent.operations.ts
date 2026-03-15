/**
 * GDPR Consent Management - GraphQL Operations
 *
 * Queries and mutations for user consent management.
 * Maps to auth-service UserConsentResolver endpoints.
 */

// ============================================================================
// Queries
// ============================================================================

/**
 * Get current consent status for the authenticated user
 * Returns all consent types with their granted/denied state
 */
export const MY_CONSENT_STATUS_QUERY = `
  query MyConsentStatus {
    myConsentStatus {
      userId
      lastUpdated
      consentVersion
      isOutdated
      consents {
        consentType
        granted
      }
    }
  }
`;

/**
 * Get consent history for the authenticated user
 */
export const MY_CONSENT_HISTORY_QUERY = `
  query MyConsentHistory($limit: Int, $offset: Int) {
    myConsentHistory(limit: $limit, offset: $offset) {
      records {
        id
        userId
        consentType
        granted
        version
        createdAt
        expiresAt
        isActive
      }
      totalCount
    }
  }
`;

/**
 * Check if user has given a specific consent
 */
export const HAS_CONSENT_QUERY = `
  query HasConsent($consentType: ConsentType!) {
    hasConsent(consentType: $consentType)
  }
`;

/**
 * Get current consent version
 */
export const CURRENT_CONSENT_VERSION_QUERY = `
  query CurrentConsentVersion {
    currentConsentVersion
  }
`;

/**
 * Check if user's consent is outdated
 */
export const IS_CONSENT_OUTDATED_QUERY = `
  query IsConsentOutdated {
    isConsentOutdated
  }
`;

// ============================================================================
// Mutations
// ============================================================================

/**
 * Record a single consent preference
 */
export const RECORD_CONSENT_MUTATION = `
  mutation RecordConsent($input: RecordConsentInput!) {
    recordConsent(input: $input) {
      id
      success
      message
    }
  }
`;

/**
 * Record multiple consent preferences at once
 */
export const RECORD_BULK_CONSENT_MUTATION = `
  mutation RecordBulkConsent($input: RecordBulkConsentInput!) {
    recordBulkConsent(input: $input) {
      ids
      success
      message
      recordedCount
    }
  }
`;

/**
 * Withdraw a previously granted consent
 */
export const WITHDRAW_CONSENT_MUTATION = `
  mutation WithdrawConsent($input: WithdrawConsentInput!) {
    withdrawConsent(input: $input) {
      success
      message
      consentType
    }
  }
`;
