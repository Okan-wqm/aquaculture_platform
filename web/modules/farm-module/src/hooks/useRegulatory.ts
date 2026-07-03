/**
 * Regulatory Report hooks for farm-module
 *
 * Handles queries and mutations for regulatory report management via GraphQL API.
 * Covers:
 * - Settings queries (company info, Maskinporten, site mappings)
 * - Configuration status & health checks
 * - Report submissions (Sea Lice, Cleaner Fish, Smolt, Planned/Executed Slaughter)
 *
 * Follows the same patterns as useHarvestPlans.ts:
 * - useAuth() for token/tenantId
 * - graphqlClient.request() for GraphQL calls
 * - React Query for caching and invalidation
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient, createTenantQueryKey } from '@aquaculture/shared-ui';
import {
  REGULATORY_SETTINGS_QUERY,
  REGULATORY_CONFIGURATION_STATUS_QUERY,
  MASKINPORTEN_STATUS_QUERY,
  MATTILSYNET_STATUS_QUERY,
  REGULATORY_HEALTH_QUERY,
  UPDATE_REGULATORY_SETTINGS_MUTATION,
  TEST_MASKINPORTEN_CONNECTION_MUTATION,
  SUBMIT_SEA_LICE_REPORT_MUTATION,
  SUBMIT_CLEANER_FISH_REPORT_MUTATION,
  SUBMIT_SMOLT_REPORT_MUTATION,
  SUBMIT_PLANNED_SLAUGHTER_REPORT_MUTATION,
  SUBMIT_EXECUTED_SLAUGHTER_REPORT_MUTATION,
  SUBMIT_WELFARE_EVENT_MUTATION,
  SUBMIT_ESCAPE_REPORT_MUTATION,
  SUBMIT_DISEASE_OUTBREAK_MUTATION,
} from '../graphql/regulatory.operations';

// ============================================================================
// TYPES
// ============================================================================

export interface CompanyAddress {
  street?: string;
  postalCode?: string;
  city?: string;
  country?: string;
}

export interface SiteLocalityMapping {
  siteId: string;
  lokalitetsnummer: number;
  siteName?: string;
}

export interface RegulatorySettings {
  id?: string;
  companyName?: string;
  organisationNumber?: string;
  companyAddress?: CompanyAddress;
  maskinportenConfigured: boolean;
  maskinportenEnvironment?: string;
  maskinportenClientIdMasked?: string;
  maskinportenKeyId?: string;
  defaultContactName?: string;
  defaultContactEmail?: string;
  defaultContactPhone?: string;
  siteLocalityMappings?: SiteLocalityMapping[];
  slaughterApprovalNumber?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface RegulatoryConfigurationStatus {
  hasCompanyInfo: boolean;
  hasMaskinportenCredentials: boolean;
  hasDefaultContact: boolean;
  siteMappingsCount: number;
  hasSlaughterApproval: boolean;
  isFullyConfigured: boolean;
}

export interface MaskinportenStatus {
  configured: boolean;
  environment: string;
  scopes: string[];
  tokenEndpoint?: string;
}

export interface MattilsynetStatus {
  baseUrl: string;
  environment: string;
  maskinportenConfigured: boolean;
}

export interface RegulatoryHealthStatus {
  maskinportenHealthy: boolean;
  mattilsynetHealthy: boolean;
  message?: string;
}

export interface MaskinportenConnectionTestResult {
  success: boolean;
  message?: string;
  error?: string;
  scopes?: string[];
}

export interface ReportValidationError {
  felt: string;
  melding: string;
}

export interface ReportSubmissionResult {
  success: boolean;
  referanse?: string;
  klientReferanse?: string;
  feilmelding?: string;
  valideringsfeil?: ReportValidationError[];
}

// --- Input Types ---

export interface UpdateRegulatorySettingsInput {
  companyName?: string;
  organisationNumber?: string;
  companyAddress?: CompanyAddress;
  maskinportenClientId?: string;
  maskinportenPrivateKey?: string;
  maskinportenKeyId?: string;
  maskinportenEnvironment?: string;
  defaultContactName?: string;
  defaultContactEmail?: string;
  defaultContactPhone?: string;
  siteLocalityMappings?: { siteId: string; lokalitetsnummer: number }[];
  slaughterApprovalNumber?: string;
}

export interface KontaktpersonInput {
  navn: string;
  epost: string;
  telefonnummer: string;
}

// Sea Lice Report
export interface SubmitSeaLiceReportInput {
  klientReferanse: string;
  organisasjonsnummer: string;
  lokalitetsnummer: number;
  kontaktperson: KontaktpersonInput;
  rapporteringsaar: number;
  rapporteringsuke: number;
  sjotemperatur: number;
  lusetelling: {
    voksneHunnlus: number;
    bevegeligeLus: number;
    fastsittendeLus: number;
  };
  ikkeMedikamentelleBehandlinger?: {
    type: string;
    gjennomfortForTelling: boolean;
    heleLokaliteten: boolean;
    antallMerder?: number;
    beskrivelse?: string;
  }[];
  medikamentelleBehandlinger?: {
    type: string;
    gjennomfortForTelling: boolean;
    heleLokaliteten: boolean;
    antallMerder?: number;
    virkestoff: {
      type: string;
      styrke?: { verdi: number; enhet: string };
      mengde?: { verdi: number; enhet: string };
      annetVirkestoff?: string;
    };
    beskrivelse?: string;
  }[];
  kombinasjonsbehandlinger?: {
    ikkeMedikamentelleBehandlinger?: {
      type: string;
      gjennomfortForTelling: boolean;
      heleLokaliteten: boolean;
      antallMerder?: number;
      beskrivelse?: string;
    }[];
    medikamentelleBehandlinger?: {
      type: string;
      gjennomfortForTelling: boolean;
      heleLokaliteten: boolean;
      antallMerder?: number;
      virkestoff: {
        type: string;
        styrke?: { verdi: number; enhet: string };
        mengde?: { verdi: number; enhet: string };
        annetVirkestoff?: string;
      };
      beskrivelse?: string;
    }[];
  }[];
  resistensMistanker?: {
    resistens: string;
    aarsak: string;
    annenResistens?: string;
    annenAarsak?: string;
  }[];
  folsomhetsundersokelser?: {
    utfortDato: string;
    laboratorium: string;
    resistens: string;
    testresultat: string;
  }[];
}

// Cleaner Fish Report
export interface SubmitCleanerFishReportInput {
  klientReferanse: string;
  organisasjonsnummer: string;
  lokalitetsnummer: number;
  kontaktperson: KontaktpersonInput;
  rapporteringsmaaned: number;
  rapporteringsaar: number;
  samdriftOrganisasjonsnumre?: string[];
  produksjonssyklusStart?: string;
  torrforKg?: number;
  vatforKg?: number;
  produksjonsenheter: {
    merdId: string;
    arter: {
      artskode: string;
      opprinnelse: string;
      beholdningVedForrigeMaanedsslutt: number;
      utsett: {
        antallFlyttetInn: number;
        antallNy: number;
      };
      uttak: {
        antallAvlivetSykdom: number;
        antallAvlivetSkader: number;
        antallAvlivetAvmagret: number;
        antallAvlivetForestaendeHaandteringAvLaksen: number;
        antallAvlivetForestaendeUgunstigLevemiljo: number;
        antallAvlivetSkalIkkeBrukes: number;
        antallSelvdod: number;
        antallFlyttetUt: number;
        antallKanIkkeGjoresRedeFor: number;
      };
    }[];
  }[];
}

// Smolt Report
export interface SubmitSmoltReportInput {
  klientReferanse: string;
  organisasjonsnummer: string;
  lokalitetsnummer: number;
  kontaktperson: KontaktpersonInput;
  rapporteringsmaaned: number;
  rapporteringsaar: number;
  produksjonsenheter: {
    karId: string;
    artskode: string;
    snittvektGram: number;
    beholdningVedMaanedsslutt: number;
    antallAvlivet: number;
    antallSelvdod: number;
    antallFlyttetEksternt: number;
  }[];
}

// Planned Slaughter Report
export interface SubmitPlannedSlaughterInput {
  klientReferanse: string;
  organisasjonsnummer: string;
  lokalitetsnummer: number;
  kontaktperson: KontaktpersonInput;
  uke: number;
  aar: number;
  godkjenningsnummer: string;
  planlagteLokaliteter: {
    organisasjonsnummer: string;
    lokalitetsnummer: number;
    ukeplanPerArt: {
      artskode: string;
      mandagKg?: number;
      tirsdagKg?: number;
      onsdagKg?: number;
      torsdagKg?: number;
      fredagKg?: number;
      lordagKg?: number;
      sondagKg?: number;
    }[];
  }[];
}

// Executed Slaughter Report
export interface SubmitExecutedSlaughterInput {
  klientReferanse: string;
  organisasjonsnummer: string;
  lokalitetsnummer: number;
  kontaktperson: KontaktpersonInput;
  slakteuke: number;
  slakteaar: number;
  godkjenningsnummer: string;
  utforteLokaliteter: {
    organisasjonsnummer: string;
    lokalitetsnummer: number;
    arter: {
      art: string;
      superiorKg: number;
      ordinaerKg: number;
      produksjonsfiskKg: number;
      utkastKg: number;
    }[];
  }[];
}

// --- Immediate "varsling" Report Inputs (Welfare / Escape / Disease) ---
// These three are legally-immediate Mattilsynet notifications dispatched by
// the backend as urgent email (no Mattilsynet REST endpoint exists for them).

/** Contact person carried on every varsling report. */
export interface VarslingKontaktpersonInput {
  navn: string;
  epost: string;
  telefonnummer?: string;
}

/** Shared identity block for all three immediate reports. */
interface VarslingBaseInput {
  klientReferanse: string;
  organisasjonsnummer: string;
  lokalitetsnummer: number;
  siteId: string;
  siteName: string;
  siteCode?: string;
  kontaktperson: VarslingKontaktpersonInput;
  siteManagerEmail?: string;
  detectedAt: string;
  reportedBy: string;
}

export interface SubmitWelfareEventInput extends VarslingBaseInput {
  welfareEventType: 'mortality_threshold' | 'equipment_failure' | 'welfare_impact';
  severity: 'high' | 'critical';
  mortalityRate?: number;
  mortalityPeriod?: string;
  affectedBatches?: string[];
  description: string;
  immediateActions: string[];
}

export interface SubmitEscapeReportInput extends VarslingBaseInput {
  estimatedCount: number;
  species: string;
  avgWeightG: number;
  totalBiomassKg: number;
  cause: string;
  affectedUnits: string[];
  recoveryOngoing: boolean;
}

export interface SubmitDiseaseOutbreakInput extends VarslingBaseInput {
  diseaseCategory: 'A' | 'C' | 'F';
  diseaseName: string;
  confirmation: 'suspected' | 'confirmed';
  affectedCount: number;
  affectedPercentage: number;
  clinicalSigns: string[];
  veterinarianNotified: boolean;
  veterinarianName?: string;
}

// ============================================================================
// QUERY KEY FACTORY
// ============================================================================

const REGULATORY_KEY = 'regulatory';

// ============================================================================
// QUERY HOOKS
// ============================================================================

/**
 * Hook to fetch regulatory settings for the current tenant
 */
export function useRegulatorySettings() {
  const { token, tenantId, isAuthenticated, isLoading: authLoading } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, REGULATORY_KEY, 'settings', tenantId),
    queryFn: async () => {
      if (!tenantId) {
        throw new Error('Tenant context required');
      }
      const data = await graphqlClient.request<{ regulatorySettings: RegulatorySettings }>(
        REGULATORY_SETTINGS_QUERY,
      );
      return data.regulatorySettings;
    },
    staleTime: 60000,
    enabled: !authLoading && isAuthenticated && !!token && !!tenantId,
    retry: (failureCount, error) => {
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (message.includes('unauthenticated') || message.includes('unauthorized') || message.includes('tenant')) {
          return false;
        }
      }
      return failureCount < 2;
    },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
  });
}

/**
 * Hook to fetch regulatory configuration status
 */
export function useRegulatoryConfigurationStatus() {
  const { token, tenantId, isAuthenticated, isLoading: authLoading } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, REGULATORY_KEY, 'configStatus', tenantId),
    queryFn: async () => {
      const data = await graphqlClient.request<{ regulatoryConfigurationStatus: RegulatoryConfigurationStatus }>(
        REGULATORY_CONFIGURATION_STATUS_QUERY,
      );
      return data.regulatoryConfigurationStatus;
    },
    staleTime: 60000,
    enabled: !authLoading && isAuthenticated && !!token && !!tenantId,
  });
}

/**
 * Hook to fetch Maskinporten status
 */
export function useMaskinportenStatus() {
  const { token, tenantId, isAuthenticated, isLoading: authLoading } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, REGULATORY_KEY, 'maskinportenStatus'),
    queryFn: async () => {
      const data = await graphqlClient.request<{ maskinportenStatus: MaskinportenStatus }>(
        MASKINPORTEN_STATUS_QUERY,
      );
      return data.maskinportenStatus;
    },
    staleTime: 60000,
    enabled: !authLoading && isAuthenticated && !!token && !!tenantId,
  });
}

/**
 * Hook to fetch Mattilsynet API status
 */
export function useMattilsynetStatus() {
  const { token, tenantId, isAuthenticated, isLoading: authLoading } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, REGULATORY_KEY, 'mattilsynetStatus', tenantId),
    queryFn: async () => {
      const data = await graphqlClient.request<{ mattilsynetStatus: MattilsynetStatus }>(
        MATTILSYNET_STATUS_QUERY,
      );
      return data.mattilsynetStatus;
    },
    staleTime: 60000,
    enabled: !authLoading && isAuthenticated && !!token && !!tenantId,
  });
}

/**
 * Hook to check regulatory services health
 */
export function useRegulatoryHealth() {
  const { token, tenantId, isAuthenticated, isLoading: authLoading } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, REGULATORY_KEY, 'health', tenantId),
    queryFn: async () => {
      const data = await graphqlClient.request<{ regulatoryHealth: RegulatoryHealthStatus }>(
        REGULATORY_HEALTH_QUERY,
      );
      return data.regulatoryHealth;
    },
    staleTime: 30000,
    enabled: !authLoading && isAuthenticated && !!token && !!tenantId,
  });
}

// ============================================================================
// HELPER: Invalidate all regulatory queries
// ============================================================================

const SUBMISSION_HISTORY_KEYS = [
  'regulatoryReports',
  'regulatoryReportSummary',
  'regulatoryReport',
  'biomassReports',
  'biomassReport',
];

function invalidateAllRegulatoryQueries(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({
    predicate: (query) =>
      Array.isArray(query.queryKey) &&
      (query.queryKey[0] === REGULATORY_KEY ||
        // Tenant-scoped persisted-submission caches (FARM-HIGH-125):
        // ['tenant', tenantId, '<key>', ...] — a fresh submission must
        // appear in the history lists without a manual refresh.
        (typeof query.queryKey[2] === 'string' &&
          SUBMISSION_HISTORY_KEYS.includes(query.queryKey[2]))),
  });
}

// ============================================================================
// MUTATION HOOKS - Settings
// ============================================================================

/**
 * Hook to update regulatory settings
 */
export function useUpdateRegulatorySettings() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateRegulatorySettingsInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ updateRegulatorySettings: RegulatorySettings }>(
        UPDATE_REGULATORY_SETTINGS_MUTATION,
        { input },
      );
      return data.updateRegulatorySettings;
    },
    onSuccess: () => {
      invalidateAllRegulatoryQueries(queryClient);
    },
  });
}

/**
 * Hook to test Maskinporten connection
 */
export function useTestMaskinportenConnection() {
  const { token, tenantId } = useAuth();

  return useMutation({
    mutationFn: async () => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ testMaskinportenConnection: MaskinportenConnectionTestResult }>(
        TEST_MASKINPORTEN_CONNECTION_MUTATION,
      );
      return data.testMaskinportenConnection;
    },
  });
}

// ============================================================================
// MUTATION HOOKS - Report Submissions
// ============================================================================

/**
 * Hook to submit a Sea Lice report to Mattilsynet
 */
export function useSubmitSeaLiceReport() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SubmitSeaLiceReportInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ submitSeaLiceReport: ReportSubmissionResult }>(
        SUBMIT_SEA_LICE_REPORT_MUTATION,
        { input },
      );
      return data.submitSeaLiceReport;
    },
    onSuccess: () => {
      invalidateAllRegulatoryQueries(queryClient);
    },
  });
}

/**
 * Hook to submit a Cleaner Fish report to Mattilsynet
 */
export function useSubmitCleanerFishReport() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SubmitCleanerFishReportInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ submitCleanerFishReport: ReportSubmissionResult }>(
        SUBMIT_CLEANER_FISH_REPORT_MUTATION,
        { input },
      );
      return data.submitCleanerFishReport;
    },
    onSuccess: () => {
      invalidateAllRegulatoryQueries(queryClient);
    },
  });
}

/**
 * Hook to submit a Smolt report to Mattilsynet
 */
export function useSubmitSmoltReport() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SubmitSmoltReportInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ submitSmoltReport: ReportSubmissionResult }>(
        SUBMIT_SMOLT_REPORT_MUTATION,
        { input },
      );
      return data.submitSmoltReport;
    },
    onSuccess: () => {
      invalidateAllRegulatoryQueries(queryClient);
    },
  });
}

/**
 * Hook to submit a Planned Slaughter report to Mattilsynet
 */
export function useSubmitPlannedSlaughterReport() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SubmitPlannedSlaughterInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ submitPlannedSlaughterReport: ReportSubmissionResult }>(
        SUBMIT_PLANNED_SLAUGHTER_REPORT_MUTATION,
        { input },
      );
      return data.submitPlannedSlaughterReport;
    },
    onSuccess: () => {
      invalidateAllRegulatoryQueries(queryClient);
    },
  });
}

/**
 * Hook to submit an Executed Slaughter report to Mattilsynet
 */
export function useSubmitExecutedSlaughterReport() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SubmitExecutedSlaughterInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ submitExecutedSlaughterReport: ReportSubmissionResult }>(
        SUBMIT_EXECUTED_SLAUGHTER_REPORT_MUTATION,
        { input },
      );
      return data.submitExecutedSlaughterReport;
    },
    onSuccess: () => {
      invalidateAllRegulatoryQueries(queryClient);
    },
  });
}

// ============================================================================
// MUTATION HOOKS - Immediate "varsling" Reports (Welfare / Escape / Disease)
// ============================================================================

/**
 * Hook to submit an immediate Welfare Event report (varsling) to Mattilsynet.
 */
export function useSubmitWelfareEvent() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SubmitWelfareEventInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ submitWelfareEvent: ReportSubmissionResult }>(
        SUBMIT_WELFARE_EVENT_MUTATION,
        { input },
      );
      return data.submitWelfareEvent;
    },
    onSuccess: () => {
      invalidateAllRegulatoryQueries(queryClient);
    },
  });
}

/**
 * Hook to submit an immediate Escape report (varsling) to Mattilsynet.
 */
export function useSubmitEscapeReport() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SubmitEscapeReportInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ submitEscapeReport: ReportSubmissionResult }>(
        SUBMIT_ESCAPE_REPORT_MUTATION,
        { input },
      );
      return data.submitEscapeReport;
    },
    onSuccess: () => {
      invalidateAllRegulatoryQueries(queryClient);
    },
  });
}

/**
 * Hook to submit an immediate Disease Outbreak report (varsling) to Mattilsynet.
 */
export function useSubmitDiseaseOutbreak() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SubmitDiseaseOutbreakInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ submitDiseaseOutbreak: ReportSubmissionResult }>(
        SUBMIT_DISEASE_OUTBREAK_MUTATION,
        { input },
      );
      return data.submitDiseaseOutbreak;
    },
    onSuccess: () => {
      invalidateAllRegulatoryQueries(queryClient);
    },
  });
}
