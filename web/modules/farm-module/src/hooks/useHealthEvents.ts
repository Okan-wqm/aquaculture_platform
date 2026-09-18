/**
 * Health Events hooks for farm-module
 * Handles CRUD operations for health events, treatment, and quarantine management via GraphQL API
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useAuth,
  graphqlClient,
  createTenantQueryKey,
  createTenantInvalidationKey,
} from '@aquaculture/shared-ui';
import type { PaginationResultV1 } from '@platform/pagination-contracts';

// ============================================================================
// TYPES - Health Events
// ============================================================================

export type HealthEventType =
  | 'disease_outbreak'
  | 'symptom_observed'
  | 'routine_inspection'
  | 'treatment_start'
  | 'treatment_end'
  | 'vaccination'
  | 'quarantine_start'
  | 'quarantine_end'
  | 'mortality_event'
  | 'recovery'
  | 'lab_result'
  | 'vet_consultation';

export type DiseaseCategory =
  | 'bacterial'
  | 'viral'
  | 'parasitic'
  | 'fungal'
  | 'nutritional'
  | 'environmental'
  | 'genetic'
  | 'unknown';

export type HealthSeverity = 'minor' | 'moderate' | 'severe' | 'critical';

export type HealthEventStatus =
  | 'active'
  | 'monitoring'
  | 'resolved'
  | 'chronic'
  | 'cancelled';

export type TreatmentMethod =
  | 'bath'
  | 'in_feed'
  | 'injection'
  | 'immersion'
  | 'topical'
  | 'environmental'
  | 'vaccination';

export interface ObservedSymptoms {
  behavioral?: string[];
  physical?: string[];
  respiratory?: string[];
  other?: string[];
}

export interface AffectedPopulation {
  estimatedAffected: number;
  affectedPercent: number;
  mortalityCount?: number;
  mortalityPercent?: number;
  spreadRate?: 'slow' | 'moderate' | 'fast' | 'contained';
}

export interface TreatmentDuration {
  startDate: string;
  endDate?: string;
  frequency: string;
  totalDays?: number;
}

export interface Medication {
  name: string;
  activeIngredient: string;
  dosage: number;
  dosageUnit: string;
  concentration?: number;
  manufacturer?: string;
  batchNumber?: string;
  expiryDate?: string;
}

export interface TreatmentDetails {
  method: TreatmentMethod;
  medication?: Medication;
  duration: TreatmentDuration;
  withdrawalPeriod?: number;
  instructions?: string;
  cost?: number;
  currency?: string;
}

export interface LabResults {
  sampleType: 'tissue' | 'water' | 'mucus' | 'blood' | 'other';
  sampleDate: string;
  labName?: string;
  testType: string;
  results: {
    parameter: string;
    value: string;
    unit?: string;
    reference?: string;
    interpretation: 'normal' | 'abnormal' | 'positive' | 'negative';
  }[];
  conclusion?: string;
  recommendations?: string;
}

export interface VetConsultation {
  vetName: string;
  vetLicense?: string;
  consultationDate: string;
  diagnosis?: string;
  differentialDiagnosis?: string[];
  recommendedTreatment?: string;
  followUpRequired: boolean;
  followUpDate?: string;
  notes?: string;
}

export interface WaterQualitySnapshot {
  temperature?: number;
  dissolvedOxygen?: number;
  pH?: number;
  ammonia?: number;
  nitrite?: number;
}

export interface HealthEvent {
  id: string;
  tenantId: string;
  batchId: string;
  tankId?: string;
  pondId?: string;
  title: string;
  description?: string;
  eventType: HealthEventType;
  eventDate: string;
  eventTime?: string;
  diseaseCategory?: DiseaseCategory;
  diseaseName?: string;
  severity: HealthSeverity;
  symptoms?: ObservedSymptoms;
  affectedPopulation?: AffectedPopulation;
  treatment?: TreatmentDetails;
  isUnderTreatment: boolean;
  treatmentEndDate?: string;
  withdrawalPeriodDays?: number;
  earliestHarvestDate?: string;
  isQuarantined: boolean;
  quarantineStartDate?: string;
  quarantineEndDate?: string;
  quarantineTankId?: string;
  labResults?: LabResults;
  labConfirmed: boolean;
  vetConsultation?: VetConsultation;
  vetNotified: boolean;
  waterQualitySnapshot?: WaterQualitySnapshot;
  relatedWaterQualityMeasurementId?: string;
  status: HealthEventStatus;
  resolvedDate?: string;
  resolutionNotes?: string;
  parentEventId?: string;
  alertIncidentId?: string;
  /** @deprecated Float — use `estimatedCostDecimal` (exact decimal string, ADR-0004). */
  estimatedCost?: number;
  estimatedCostDecimal?: string | null;
  currency?: string;
  reportedBy: string;
  notes?: string;
  attachments?: string[];
  followUpRequired: boolean;
  nextFollowUpDate?: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// FILTER AND INPUT TYPES
// ============================================================================

export interface HealthEventFilter {
  batchId?: string;
  batchIds?: string[];
  tankId?: string;
  tankIds?: string[];
  pondId?: string;
  siteId?: string;
  eventType?: HealthEventType;
  eventTypes?: HealthEventType[];
  severity?: HealthSeverity;
  severities?: HealthSeverity[];
  status?: HealthEventStatus;
  statuses?: HealthEventStatus[];
  diseaseCategory?: DiseaseCategory;
  diseaseCategories?: DiseaseCategory[];
  diseaseName?: string;
  fromDate?: string;
  toDate?: string;
  createdFrom?: string;
  createdTo?: string;
  isUnderTreatment?: boolean;
  isQuarantined?: boolean;
  labConfirmed?: boolean;
  vetNotified?: boolean;
  followUpRequired?: boolean;
  followUpOverdue?: boolean;
  followUpFrom?: string;
  followUpTo?: string;
  reportedBy?: string;
  searchText?: string;
  parentEventId?: string;
  alertIncidentId?: string;
  activeOnly?: boolean;
  criticalOnly?: boolean;
  hasWithdrawalPeriod?: boolean;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortDirection?: 'ASC' | 'DESC';
}

export interface CreateHealthEventInput {
  batchId: string;
  tankId?: string;
  pondId?: string;
  title: string;
  description?: string;
  eventType: HealthEventType;
  eventDate: string;
  eventTime?: string;
  diseaseCategory?: DiseaseCategory;
  diseaseName?: string;
  severity?: HealthSeverity;
  symptomsObserved?: ObservedSymptoms;
  diagnosis?: string;
  affectedPopulation?: AffectedPopulation;
  affectedCount?: number;
  mortalityCount?: number;
  treatment?: TreatmentDetails;
  medication?: string;
  isUnderTreatment?: boolean;
  treatmentEndDate?: string;
  withdrawalPeriodDays?: number;
  isQuarantined?: boolean;
  quarantineStartDate?: string;
  quarantineTankId?: string;
  labResults?: LabResults;
  labConfirmed?: boolean;
  vetConsultation?: VetConsultation;
  vetNotified?: boolean;
  waterQualitySnapshot?: WaterQualitySnapshot;
  relatedWaterQualityMeasurementId?: string;
  status?: HealthEventStatus;
  parentEventId?: string;
  alertIncidentId?: string;
  estimatedCost?: number;
  currency?: string;
  reportedBy: string;
  observedAt?: string;
  notes?: string;
  attachments?: string[];
  followUpRequired?: boolean;
  followUpDate?: string;
}

export interface UpdateHealthEventInput {
  id: string;
  tankId?: string;
  pondId?: string;
  title?: string;
  description?: string;
  eventType?: HealthEventType;
  eventDate?: string;
  eventTime?: string;
  diseaseCategory?: DiseaseCategory;
  diseaseName?: string;
  severity?: HealthSeverity;
  symptomsObserved?: ObservedSymptoms;
  diagnosis?: string;
  affectedPopulation?: AffectedPopulation;
  affectedCount?: number;
  mortalityCount?: number;
  treatment?: TreatmentDetails;
  medication?: string;
  isUnderTreatment?: boolean;
  treatmentEndDate?: string;
  withdrawalPeriodDays?: number;
  earliestHarvestDate?: string;
  isQuarantined?: boolean;
  quarantineStartDate?: string;
  quarantineEndDate?: string;
  quarantineTankId?: string;
  labResults?: LabResults;
  labConfirmed?: boolean;
  vetConsultation?: VetConsultation;
  vetNotified?: boolean;
  waterQualitySnapshot?: WaterQualitySnapshot;
  relatedWaterQualityMeasurementId?: string;
  status?: HealthEventStatus;
  resolvedDate?: string;
  resolutionNotes?: string;
  parentEventId?: string;
  alertIncidentId?: string;
  estimatedCost?: number;
  currency?: string;
  notes?: string;
  attachments?: string[];
  followUpRequired?: boolean;
  followUpDate?: string;
}

export interface TreatmentInput {
  method: TreatmentMethod;
  medication?: {
    name: string;
    activeIngredient: string;
    dosage: number;
    dosageUnit: string;
    concentration?: number;
    manufacturer?: string;
    batchNumber?: string;
    expiryDate?: string;
  };
  duration: {
    startDate: string;
    endDate?: string;
    frequency: string;
    totalDays?: number;
  };
  withdrawalPeriod?: number;
  instructions?: string;
  cost?: number;
  currency?: string;
}

export interface HealthEventStats {
  total: number;
  active: number;
  critical: number;
  underTreatment: number;
  quarantined: number;
  resolved: number;
  byEventType: Record<string, number>;
  bySeverity: Record<string, number>;
}

// ============================================================================
// GRAPHQL FIELDS
// ============================================================================

const HEALTH_EVENT_FIELDS = `
  id
  tenantId
  batchId
  tankId
  pondId
  title
  description
  eventType
  eventDate
  eventTime
  diseaseCategory
  diseaseName
  severity
  symptoms
  affectedPopulation
  treatment
  isUnderTreatment
  treatmentEndDate
  withdrawalPeriodDays
  earliestHarvestDate
  isQuarantined
  quarantineStartDate
  quarantineEndDate
  quarantineTankId
  labResults
  labConfirmed
  vetConsultation
  vetNotified
  waterQualitySnapshot
  relatedWaterQualityMeasurementId
  status
  resolvedDate
  resolutionNotes
  parentEventId
  alertIncidentId
  estimatedCost
  estimatedCostDecimal
  currency
  reportedBy
  notes
  attachments
  followUpRequired
  nextFollowUpDate
  createdAt
  updatedAt
`;

// ============================================================================
// HOOKS - Health Events
// ============================================================================

export function useHealthEvents(filter?: HealthEventFilter) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'healthEvents', filter),
    queryFn: async () => {
      const query = `
        query HealthEvents($filter: HealthEventFilterInput) {
          healthEvents(filter: $filter) {
            items {
              ${HEALTH_EVENT_FIELDS}
            }
            total
            page
            limit
            totalPages
            hasNextPage
            hasPreviousPage
          }
        }
      `;

      const result = await graphqlClient.request<{
        healthEvents: PaginationResultV1<HealthEvent>;
      }>(query, { filter });

      return result.healthEvents;
    },
    enabled: !!token && !!tenantId,
  });
}

export function useHealthEvent(id: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'healthEvent', id),
    queryFn: async () => {
      const query = `
        query HealthEvent($id: ID!) {
          healthEvent(id: $id) {
            ${HEALTH_EVENT_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ healthEvent: HealthEvent }>(
        query,
        { id }
      );

      return result.healthEvent;
    },
    enabled: !!token && !!tenantId && !!id,
  });
}

export function useHealthEventsByBatch(batchId: string, activeOnly = false) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'healthEventsByBatch', batchId, activeOnly),
    queryFn: async () => {
      const query = `
        query HealthEventsByBatch($batchId: ID!, $activeOnly: Boolean) {
          healthEventsByBatch(batchId: $batchId, activeOnly: $activeOnly) {
            ${HEALTH_EVENT_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{
        healthEventsByBatch: HealthEvent[];
      }>(query, { batchId, activeOnly });

      return result.healthEventsByBatch;
    },
    enabled: !!token && !!tenantId && !!batchId,
  });
}

export function useCriticalHealthEvents() {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'criticalHealthEvents'),
    queryFn: async () => {
      const query = `
        query CriticalHealthEvents {
          criticalHealthEvents {
            ${HEALTH_EVENT_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{
        criticalHealthEvents: HealthEvent[];
      }>(query, {});

      return result.criticalHealthEvents;
    },
    enabled: !!token && !!tenantId,
  });
}

export function useOverdueHealthFollowUps() {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'overdueHealthFollowUps'),
    queryFn: async () => {
      const query = `
        query OverdueHealthFollowUps {
          overdueHealthFollowUps {
            ${HEALTH_EVENT_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{
        overdueHealthFollowUps: HealthEvent[];
      }>(query, {});

      return result.overdueHealthFollowUps;
    },
    enabled: !!token && !!tenantId,
  });
}

export function useHealthEventStats() {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'healthEventStats'),
    queryFn: async () => {
      const query = `
        query HealthEventStats {
          healthEventStats {
            total
            active
            critical
            underTreatment
            quarantined
            resolved
            byEventType
            bySeverity
          }
        }
      `;

      const result = await graphqlClient.request<{
        healthEventStats: HealthEventStats;
      }>(query, {});

      return result.healthEventStats;
    },
    enabled: !!token && !!tenantId,
  });
}

// ============================================================================
// MUTATIONS - CRUD
// ============================================================================

export function useCreateHealthEvent() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateHealthEventInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const mutation = `
        mutation CreateHealthEvent($input: CreateHealthEventInput!) {
          createHealthEvent(input: $input) {
            ${HEALTH_EVENT_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ createHealthEvent: HealthEvent }>(
        mutation,
        { input }
      );

      return result.createHealthEvent;
    },
    onSuccess: () => {
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'healthEvents') });
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'healthEventStats') });
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'criticalHealthEvents') });
    },
  });
}

export function useUpdateHealthEvent() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateHealthEventInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const mutation = `
        mutation UpdateHealthEvent($id: ID!, $input: UpdateHealthEventInput!) {
          updateHealthEvent(id: $id, input: $input) {
            ${HEALTH_EVENT_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ updateHealthEvent: HealthEvent }>(
        mutation,
        { id: input.id, input }
      );

      return result.updateHealthEvent;
    },
    onSuccess: (data) => {
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'healthEvents') });
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'healthEvent', data.id) });
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'healthEventStats') });
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'criticalHealthEvents') });
    },
  });
}

export function useDeleteHealthEvent() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const mutation = `
        mutation DeleteHealthEvent($id: ID!) {
          deleteHealthEvent(id: $id)
        }
      `;

      const result = await graphqlClient.request<{ deleteHealthEvent: boolean }>(
        mutation,
        { id }
      );

      return result.deleteHealthEvent;
    },
    onSuccess: () => {
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'healthEvents') });
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'healthEventStats') });
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'criticalHealthEvents') });
    },
  });
}

// ============================================================================
// MUTATIONS - TREATMENT
// ============================================================================

export function useStartHealthEventTreatment() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, treatment }: { id: string; treatment: TreatmentInput }) => {
      const mutation = `
        mutation StartHealthEventTreatment($id: ID!, $treatment: TreatmentDetailsInput!) {
          startHealthEventTreatment(id: $id, treatment: $treatment) {
            ${HEALTH_EVENT_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ startHealthEventTreatment: HealthEvent }>(
        mutation,
        { id, treatment }
      );

      return result.startHealthEventTreatment;
    },
    onSuccess: (data) => {
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'healthEvents') });
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'healthEvent', data.id) });
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'healthEventStats') });
    },
  });
}

export function useEndHealthEventTreatment() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, notes }: { id: string; notes?: string }) => {
      const mutation = `
        mutation EndHealthEventTreatment($id: ID!, $notes: String) {
          endHealthEventTreatment(id: $id, notes: $notes) {
            ${HEALTH_EVENT_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ endHealthEventTreatment: HealthEvent }>(
        mutation,
        { id, notes }
      );

      return result.endHealthEventTreatment;
    },
    onSuccess: (data) => {
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'healthEvents') });
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'healthEvent', data.id) });
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'healthEventStats') });
    },
  });
}

// ============================================================================
// MUTATIONS - QUARANTINE
// ============================================================================

export function useStartHealthEventQuarantine() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, quarantineTankId }: { id: string; quarantineTankId?: string }) => {
      const mutation = `
        mutation StartHealthEventQuarantine($id: ID!, $quarantineTankId: ID) {
          startHealthEventQuarantine(id: $id, quarantineTankId: $quarantineTankId) {
            ${HEALTH_EVENT_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ startHealthEventQuarantine: HealthEvent }>(
        mutation,
        { id, quarantineTankId }
      );

      return result.startHealthEventQuarantine;
    },
    onSuccess: (data) => {
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'healthEvents') });
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'healthEvent', data.id) });
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'healthEventStats') });
    },
  });
}

export function useEndHealthEventQuarantine() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const mutation = `
        mutation EndHealthEventQuarantine($id: ID!) {
          endHealthEventQuarantine(id: $id) {
            ${HEALTH_EVENT_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ endHealthEventQuarantine: HealthEvent }>(
        mutation,
        { id }
      );

      return result.endHealthEventQuarantine;
    },
    onSuccess: (data) => {
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'healthEvents') });
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'healthEvent', data.id) });
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'healthEventStats') });
    },
  });
}

// ============================================================================
// MUTATIONS - RESOLUTION
// ============================================================================

export function useResolveHealthEvent() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, notes }: { id: string; notes?: string }) => {
      const mutation = `
        mutation ResolveHealthEvent($id: ID!, $notes: String) {
          resolveHealthEvent(id: $id, notes: $notes) {
            ${HEALTH_EVENT_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ resolveHealthEvent: HealthEvent }>(
        mutation,
        { id, notes }
      );

      return result.resolveHealthEvent;
    },
    onSuccess: (data) => {
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'healthEvents') });
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'healthEvent', data.id) });
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'healthEventStats') });
      if (tenantId) queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'criticalHealthEvents') });
    },
  });
}
