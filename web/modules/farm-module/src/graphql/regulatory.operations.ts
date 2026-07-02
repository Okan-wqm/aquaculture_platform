/**
 * Regulatory Reports GraphQL Operations
 *
 * All GraphQL queries and mutations for regulatory report management.
 * Maps to the backend regulatory.resolver.ts operations.
 *
 * Reports covered:
 * - Sea Lice (Lakselus) - Weekly
 * - Cleaner Fish (Rensefisk) - Monthly
 * - Smolt (Settefisk) - Monthly
 * - Planned Slaughter (Planlagt Slakt) - Weekly
 * - Executed Slaughter (Utfort Slakt) - Weekly
 *
 * Settings & Status:
 * - Regulatory settings (company info, Maskinporten credentials)
 * - Maskinporten connection test
 * - Configuration status
 * - Service health
 *
 * @module FarmModule/GraphQL
 */

// ============================================================================
// FRAGMENTS
// ============================================================================

const REPORT_SUBMISSION_RESULT_FIELDS = `
  success
  referanse
  klientReferanse
  feilmelding
  valideringsfeil {
    felt
    melding
  }
`;

const REGULATORY_SETTINGS_FIELDS = `
  id
  companyName
  organisationNumber
  companyAddress {
    street
    postalCode
    city
    country
  }
  maskinportenConfigured
  maskinportenEnvironment
  maskinportenClientIdMasked
  maskinportenKeyId
  defaultContactName
  defaultContactEmail
  defaultContactPhone
  siteLocalityMappings {
    siteId
    lokalitetsnummer
    siteName
  }
  slaughterApprovalNumber
  createdAt
  updatedAt
`;

// ============================================================================
// QUERIES - Regulatory Settings & Status
// ============================================================================

/**
 * Get regulatory settings for the current tenant
 */
export const REGULATORY_SETTINGS_QUERY = `
  query RegulatorySettings {
    regulatorySettings {
      ${REGULATORY_SETTINGS_FIELDS}
    }
  }
`;

/**
 * Get regulatory configuration status
 */
export const REGULATORY_CONFIGURATION_STATUS_QUERY = `
  query RegulatoryConfigurationStatus {
    regulatoryConfigurationStatus {
      hasCompanyInfo
      hasMaskinportenCredentials
      hasDefaultContact
      siteMappingsCount
      hasSlaughterApproval
      isFullyConfigured
    }
  }
`;

/**
 * Get Maskinporten configuration status
 */
export const MASKINPORTEN_STATUS_QUERY = `
  query MaskinportenStatus {
    maskinportenStatus {
      configured
      environment
      scopes
      tokenEndpoint
    }
  }
`;

/**
 * Get Mattilsynet API configuration status
 */
export const MATTILSYNET_STATUS_QUERY = `
  query MattilsynetStatus {
    mattilsynetStatus {
      baseUrl
      environment
      maskinportenConfigured
    }
  }
`;

/**
 * Check regulatory services health
 */
export const REGULATORY_HEALTH_QUERY = `
  query RegulatoryHealth {
    regulatoryHealth {
      maskinportenHealthy
      mattilsynetHealthy
      message
    }
  }
`;

// ============================================================================
// MUTATIONS - Regulatory Settings
// ============================================================================

/**
 * Update regulatory settings for current tenant
 */
export const UPDATE_REGULATORY_SETTINGS_MUTATION = `
  mutation UpdateRegulatorySettings($input: UpdateRegulatorySettingsInput!) {
    updateRegulatorySettings(input: $input) {
      ${REGULATORY_SETTINGS_FIELDS}
    }
  }
`;

/**
 * Test Maskinporten connection using tenant credentials
 */
export const TEST_MASKINPORTEN_CONNECTION_MUTATION = `
  mutation TestMaskinportenConnection {
    testMaskinportenConnection {
      success
      message
      error
      scopes
    }
  }
`;

// ============================================================================
// MUTATIONS - Report Submissions
// ============================================================================

/**
 * Submit a Sea Lice report to Mattilsynet
 * POST /api/lakselus/v1/lakselus
 */
export const SUBMIT_SEA_LICE_REPORT_MUTATION = `
  mutation SubmitSeaLiceReport($input: SubmitSeaLiceReportInput!) {
    submitSeaLiceReport(input: $input) {
      ${REPORT_SUBMISSION_RESULT_FIELDS}
    }
  }
`;

/**
 * Submit a Cleaner Fish report to Mattilsynet
 * POST /api/rensefisk/v1/rensefisk
 */
export const SUBMIT_CLEANER_FISH_REPORT_MUTATION = `
  mutation SubmitCleanerFishReport($input: SubmitCleanerFishReportInput!) {
    submitCleanerFishReport(input: $input) {
      ${REPORT_SUBMISSION_RESULT_FIELDS}
    }
  }
`;

/**
 * Submit a Smolt report to Mattilsynet
 * POST /api/settefisk/v1/settefisk
 */
export const SUBMIT_SMOLT_REPORT_MUTATION = `
  mutation SubmitSmoltReport($input: SubmitSmoltReportInput!) {
    submitSmoltReport(input: $input) {
      ${REPORT_SUBMISSION_RESULT_FIELDS}
    }
  }
`;

/**
 * Submit a Planned Slaughter report to Mattilsynet
 * POST /api/slakt/v1/planlagt
 */
export const SUBMIT_PLANNED_SLAUGHTER_REPORT_MUTATION = `
  mutation SubmitPlannedSlaughterReport($input: SubmitPlannedSlaughterInput!) {
    submitPlannedSlaughterReport(input: $input) {
      ${REPORT_SUBMISSION_RESULT_FIELDS}
    }
  }
`;

/**
 * Submit an Executed Slaughter report to Mattilsynet
 * POST /api/slakt/v1/utfort
 */
export const SUBMIT_EXECUTED_SLAUGHTER_REPORT_MUTATION = `
  mutation SubmitExecutedSlaughterReport($input: SubmitExecutedSlaughterInput!) {
    submitExecutedSlaughterReport(input: $input) {
      ${REPORT_SUBMISSION_RESULT_FIELDS}
    }
  }
`;

// ============================================================================
// MUTATIONS - Immediate "varsling" Reports (Welfare / Escape / Disease)
// ============================================================================
//
// These three are the legally-immediate Mattilsynet notifications. They are
// NOT part of the Mattilsynet REST API — the backend dispatches them as urgent
// email to varsling.akva@mattilsynet.no via the notification-service. The
// resolver returns the same ReportSubmissionResult shape as the REST reports.

/**
 * Submit an immediate Welfare Event report (varsling) to Mattilsynet.
 */
export const SUBMIT_WELFARE_EVENT_MUTATION = `
  mutation SubmitWelfareEvent($input: SubmitWelfareEventInput!) {
    submitWelfareEvent(input: $input) {
      ${REPORT_SUBMISSION_RESULT_FIELDS}
    }
  }
`;

/**
 * Submit an immediate Escape report (varsling) to Mattilsynet.
 */
export const SUBMIT_ESCAPE_REPORT_MUTATION = `
  mutation SubmitEscapeReport($input: SubmitEscapeReportInput!) {
    submitEscapeReport(input: $input) {
      ${REPORT_SUBMISSION_RESULT_FIELDS}
    }
  }
`;

/**
 * Submit an immediate Disease Outbreak report (varsling) to Mattilsynet.
 */
export const SUBMIT_DISEASE_OUTBREAK_MUTATION = `
  mutation SubmitDiseaseOutbreak($input: SubmitDiseaseOutbreakInput!) {
    submitDiseaseOutbreak(input: $input) {
      ${REPORT_SUBMISSION_RESULT_FIELDS}
    }
  }
`;

// ============================================================================
// BIOMASS REPORT (phase 2.1)
// ============================================================================

/**
 * Create or update a monthly biomass report for a site. Pass
 * `input.submit = true` to finalise — a SUBMITTED period becomes
 * immutable. The mutation is idempotent per
 * (siteId, reportMonth, reportYear) so re-saving a DRAFT overwrites in
 * place instead of duplicating.
 */
export const CREATE_BIOMASS_REPORT_MUTATION = `
  mutation CreateBiomassReport($input: CreateBiomassReportInput!) {
    createBiomassReport(input: $input) {
      id
      siteId
      reportMonth
      reportYear
      status
      totalBiomassKg
      submittedAt
      updatedAt
    }
  }
`;

/** Single-period lookup — drives the tab's pre-fill when returning to a drafted month. */
export const BIOMASS_REPORT_QUERY = `
  query BiomassReport($siteId: ID!, $reportMonth: Int!, $reportYear: Int!) {
    biomassReport(siteId: $siteId, reportMonth: $reportMonth, reportYear: $reportYear) {
      id
      status
      totalBiomassKg
      reportData
      submittedAt
      generatedBy
      updatedAt
    }
  }
`;

/** Period history — feeds the "recent reports" list on the tab. */
export const BIOMASS_REPORTS_QUERY = `
  query BiomassReports($siteId: ID!, $limit: Int) {
    biomassReports(siteId: $siteId, limit: $limit) {
      id
      reportMonth
      reportYear
      status
      totalBiomassKg
      submittedAt
      updatedAt
    }
  }
`;

// ============================================================================
// PERSISTED SUBMISSION HISTORY (FARM-HIGH-125)
// ============================================================================

const REGULATORY_REPORT_ROW_FIELDS = `
  id
  reportType
  klientReferanse
  siteId
  lokalitetsnummer
  reportYear
  reportWeek
  reportMonth
  status
  referanse
  feilmelding
  submittedBy
  submittedAt
  createdAt
`;

/** Submission history for one report type, newest first. */
export const REGULATORY_REPORTS_QUERY = `
  query RegulatoryReports($reportType: RegulatoryReportType!, $siteId: ID, $limit: Int, $offset: Int) {
    regulatoryReports(reportType: $reportType, siteId: $siteId, limit: $limit, offset: $offset) {
      ${REGULATORY_REPORT_ROW_FIELDS}
    }
  }
`;

/** One persisted submission including the full submitted payload. */
export const REGULATORY_REPORT_QUERY = `
  query RegulatoryReport($id: ID!) {
    regulatoryReport(id: $id) {
      ${REGULATORY_REPORT_ROW_FIELDS}
      payload
    }
  }
`;

/** Per-type status counts + last submission — feeds page badges/summary. */
export const REGULATORY_REPORT_SUMMARY_QUERY = `
  query RegulatoryReportSummary($siteId: ID) {
    regulatoryReportSummary(siteId: $siteId) {
      reportType
      pendingCount
      submittedCount
      queuedCount
      failedCount
      lastSubmittedAt
    }
  }
`;
