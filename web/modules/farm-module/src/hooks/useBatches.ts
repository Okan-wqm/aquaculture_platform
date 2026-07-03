/**
 * Batch hooks for farm-module
 * Handles CRUD operations for batches via GraphQL API
 */
import { useRef } from 'react';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';

// Types - GraphQL enum KEY'leri ile uyumlu (UPPERCASE)
export type BatchStatus =
  | 'QUARANTINE'
  | 'ACTIVE'
  | 'GROWING'
  | 'PRE_HARVEST'
  | 'HARVESTING'
  | 'HARVESTED'
  | 'TRANSFERRED'
  | 'FAILED'
  | 'CLOSED';

export type BatchInputType =
  | 'EGGS'
  | 'LARVAE'
  | 'POST_LARVAE'
  | 'FRY'
  | 'FINGERLINGS'
  | 'JUVENILES'
  | 'ADULTS'
  | 'BROODSTOCK';

export type ArrivalMethod =
  | 'AIR_CARGO'
  | 'TRUCK'
  | 'BOAT'
  | 'RAIL'
  | 'LOCAL_PICKUP'
  | 'OTHER';

export type BatchDocumentType =
  | 'HEALTH_CERTIFICATE'
  | 'IMPORT_DOCUMENT'
  | 'ORIGIN_CERTIFICATE'
  | 'QUALITY_CERTIFICATE'
  | 'VETERINARY_CERTIFICATE'
  | 'TRANSPORT_DOCUMENT'
  | 'OTHER';

// Tank Operation Types - lowercase to match backend enum values
export type MortalityReason =
  | 'disease'
  | 'water_quality'
  | 'stress'
  | 'handling'
  | 'temperature'
  | 'oxygen'
  | 'predation'
  | 'cannibalism'
  | 'unknown'
  | 'other';

export type CullReason =
  | 'small_size'
  | 'deformed'
  | 'sick'
  | 'poor_growth'
  | 'grading'
  | 'quality'
  | 'other';

export type QualityGrade =
  | 'PREMIUM'
  | 'GRADE_A'
  | 'GRADE_B'
  | 'GRADE_C'
  | 'REJECT';

// Tank Operation Input Types
export interface RecordMortalityInput {
  batchId: string;
  tankId: string;
  quantity: number;
  reason: MortalityReason;
  detail?: string;
  observedAt?: string;
  observedBy?: string;
  avgWeightG?: number;
  notes?: string;
}

export interface RecordCullInput {
  batchId: string;
  tankId: string;
  quantity: number;
  reason: CullReason;
  detail?: string;
  culledAt?: string;
  avgWeightG?: number;
  notes?: string;
}

export interface TransferBatchInput {
  batchId: string;
  sourceTankId: string;
  destinationTankId: string;
  quantity: number;
  avgWeightG?: number;
  transferredAt?: string;
  transferReason?: string;
  notes?: string;
  skipCapacityCheck?: boolean;
}

/** One grading destination as edited in the UI — the per-output envelope is attached by useRecordGrading. */
export interface GradingOutputDraft {
  /**
   * FARM-MEDIUM-129: stable per-row identity minted at row creation. The
   * per-output at-most-once clientCommandId is keyed on THIS, not on the array
   * index — so trimming already-committed rows and resubmitting the remainder
   * (the resume path the backend + modal advertise) keeps each surviving row's
   * id stable instead of reusing a committed id under a new payload. Stripped
   * before the request reaches the server.
   */
  rowKey: string;
  destinationTankId: string;
  quantity: number;
  avgWeightG: number;
  sizeClass?: string;
}

export interface RecordGradingInput {
  batchId: string;
  sourceTankId: string;
  gradedAt?: string;
  notes?: string;
  outputs: GradingOutputDraft[];
}

export type AllocationType = 'INITIAL_STOCKING' | 'TRANSFER_IN' | 'REDISTRIBUTION';

export type BatchCloseReason =
  | 'HARVEST_COMPLETED'
  | 'TOTAL_MORTALITY'
  | 'DISEASE_OUTBREAK'
  | 'COMMERCIAL_DECISION'
  | 'FAILED'
  | 'MERGED'
  | 'OTHER';

export interface AllocateBatchToTankInput {
  batchId: string;
  tankId: string;
  quantity: number;
  avgWeightG: number;
  allocationType?: AllocationType;
  allocatedAt?: string;
  notes?: string;
}

export interface ActiveTreatmentInfo {
  eventCode: string;
  productName: string;
  earliestHarvestDate: string;
  daysRemaining: number;
}

export interface CreateHarvestRecordInput {
  batchId: string;
  tankId: string;
  quantityHarvested: number;
  averageWeight: number;
  totalBiomass?: number;
  qualityGrade: QualityGrade;
  lotNumber?: string;
  harvestDate?: string;
  pricePerKg?: number;
  buyerName?: string;
  notes?: string;
}

export interface BatchDocument {
  id: string;
  documentType: BatchDocumentType;
  documentName: string;
  documentNumber?: string;
  storagePath: string;
  storageUrl: string;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  issueDate?: string;
  expiryDate?: string;
  issuingAuthority?: string;
  notes?: string;
  createdAt: string;
}

export interface BatchWeight {
  initial: {
    avgWeight: number;
    totalBiomass: number;
    measuredAt: string;
  };
  theoretical: {
    avgWeight: number;
    totalBiomass: number;
    lastCalculatedAt: string;
    basedOnFCR: number;
  };
  actual: {
    avgWeight: number;
    totalBiomass: number;
    lastMeasuredAt: string;
    sampleSize: number;
    confidencePercent: number;
  };
  variance: {
    weightDifference: number;
    percentageDifference: number;
    isSignificant: boolean;
  };
}

export interface BatchFCR {
  target: number;
  actual: number;
  theoretical: number;
  isUserOverride: boolean;
  lastUpdatedAt: string;
}

export interface Batch {
  id: string;
  batchNumber: string;
  name?: string;
  description?: string;
  speciesId: string;
  strain?: string;
  inputType: BatchInputType;
  initialQuantity: number;
  currentQuantity: number;
  totalMortality: number;
  harvestedQuantity?: number;
  cullCount: number;
  totalFeedConsumed: number;
  totalFeedCost: number;
  retentionRate?: number;
  sgr?: number;
  costPerKg?: number;
  weight: BatchWeight;
  fcr: BatchFCR;
  stockedAt: string;
  expectedHarvestDate?: string;
  actualHarvestDate?: string;
  supplierId?: string;
  supplierBatchNumber?: string;
  purchaseCost?: number;
  currency?: string;
  arrivalMethod?: ArrivalMethod;
  status: BatchStatus;
  statusChangedAt?: string;
  statusReason?: string;
  isActive: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  // Computed fields
  currentBiomassKg?: number;
  currentAvgWeightG?: number;
  mortalityRate?: number;
  survivalRate?: number;
  daysInProduction?: number;
  // Relations
  documents?: BatchDocument[];
  healthCertificates?: BatchDocument[];
  importDocuments?: BatchDocument[];
}

export interface AvailableTank {
  id: string;
  code: string;
  name: string;
  volume: number;
  maxBiomass: number;
  currentBiomass: number;
  availableCapacity: number;
  currentCount: number;
  maxDensity: number;
  currentDensity: number;
  status: string;
  departmentId: string;
  departmentName: string;
  siteId?: string;
  siteName?: string;
}

export interface BatchDocumentInput {
  documentType: BatchDocumentType;
  documentName: string;
  documentNumber?: string;
  storagePath: string;
  storageUrl: string;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  issueDate?: string;
  expiryDate?: string;
  issuingAuthority?: string;
  notes?: string;
}

export interface InitialWeightInput {
  avgWeight: number;
  totalBiomass: number;
}

export interface InitialLocationInput {
  locationType: 'tank' | 'pond';
  tankId?: string;
  pondId?: string;
  quantity: number;
  biomass: number;
  allocationDate?: string;
}

export interface CreateBatchInput {
  name?: string;
  description?: string;
  speciesId: string;
  strain?: string;
  inputType: BatchInputType;
  initialQuantity: number;
  initialWeight: InitialWeightInput;
  stockedAt: string;
  expectedHarvestDate?: string;
  targetFCR: number;
  supplierId?: string;
  supplierBatchNumber?: string;
  purchaseCost?: number;
  currency?: string;
  arrivalMethod?: ArrivalMethod;
  healthCertificates?: BatchDocumentInput[];
  importDocuments?: BatchDocumentInput[];
  initialLocations: InitialLocationInput[];
  notes?: string;
}

export interface BatchListFilter {
  status?: BatchStatus[];
  speciesId?: string;
  inputType?: BatchInputType;
  supplierId?: string;
  tankId?: string;
  siteId?: string;
  departmentId?: string;
  isActive?: boolean;
  stockedAfter?: string;
  stockedBefore?: string;
  searchTerm?: string;
}

interface BatchListResponse {
  items: Batch[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

// GraphQL Queries
// FARM-LOW-143: the ~40 batch scalar fields, shared by BATCH_LIST_QUERY and
// BATCH_QUERY so the list and detail selections cannot drift apart (a classic
// "field on detail but missing on list" source). Detail-only relations
// (documents, healthCertificates) are appended per-query.
const BATCH_CORE_FIELDS = `
  id
  batchNumber
  name
  description
  speciesId
  strain
  inputType
  initialQuantity
  currentQuantity
  totalMortality
  harvestedQuantity
  cullCount
  totalFeedConsumed
  totalFeedCost
  retentionRate
  sgr
  costPerKg
  weight
  fcr
  stockedAt
  expectedHarvestDate
  actualHarvestDate
  supplierId
  supplierBatchNumber
  purchaseCost
  currency
  arrivalMethod
  status
  statusChangedAt
  statusReason
  isActive
  notes
  createdAt
  updatedAt
  currentBiomassKg
  currentAvgWeightG
  mortalityRate
  survivalRate
  daysInProduction
`;

const BATCH_LIST_QUERY = `
  query Batches($filter: BatchFilterInput, $page: Int, $limit: Int, $sortBy: String, $sortOrder: String) {
    batches(filter: $filter, page: $page, limit: $limit, sortBy: $sortBy, sortOrder: $sortOrder) {
      items {
        ${BATCH_CORE_FIELDS}
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

const BATCH_QUERY = `
  query Batch($id: ID!) {
    batch(id: $id) {
      ${BATCH_CORE_FIELDS}
      documents {
        id
        documentType
        documentName
        documentNumber
        storagePath
        storageUrl
        originalFilename
        mimeType
        fileSize
        issueDate
        expiryDate
        issuingAuthority
        notes
        createdAt
      }
      healthCertificates {
        id
        documentType
        documentName
        documentNumber
        storageUrl
        originalFilename
        mimeType
        fileSize
        issueDate
        expiryDate
        issuingAuthority
      }
      importDocuments {
        id
        documentType
        documentName
        documentNumber
        storageUrl
        originalFilename
        mimeType
        fileSize
        issueDate
        expiryDate
      }
    }
  }
`;

const AVAILABLE_TANKS_QUERY = `
  query AvailableTanks($siteId: ID, $departmentId: ID, $excludeFullTanks: Boolean) {
    availableTanks(siteId: $siteId, departmentId: $departmentId, excludeFullTanks: $excludeFullTanks) {
      id
      code
      name
      volume
      maxBiomass
      currentBiomass
      availableCapacity
      currentCount
      maxDensity
      currentDensity
      status
      departmentId
      departmentName
      siteId
      siteName
    }
  }
`;

const GENERATE_BATCH_NUMBER_QUERY = `
  query GenerateBatchNumber {
    generateBatchNumber
  }
`;

const CREATE_BATCH_MUTATION = `
  mutation CreateBatch($input: CreateBatchInput!) {
    createBatch(input: $input) {
      id
      batchNumber
      name
      speciesId
      inputType
      initialQuantity
      currentQuantity
      stockedAt
      status
      arrivalMethod
      createdAt
    }
  }
`;

/**
 * Hook to fetch batch list
 */
export function useBatchList(
  filter?: BatchListFilter,
  options?: {
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: 'ASC' | 'DESC';
  }
) {
  const { token, tenantId, isAuthenticated, isLoading: authLoading } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'batches', 'list', tenantId, filter, options),
    queryFn: async () => {
      // Double-check tenantId before request
      if (!tenantId) {
        throw new Error('Tenant context required');
      }

      const data = await graphqlClient.request<{ batches: BatchListResponse }>(
        BATCH_LIST_QUERY,
        {
          filter,
          page: options?.page ?? 1,
          limit: options?.limit ?? 20,
          sortBy: options?.sortBy ?? 'stockedAt',
          sortOrder: options?.sortOrder ?? 'DESC',
        }
      );
      return data.batches;
    },
    staleTime: 30000,
    // Only enable when we have valid auth context
    enabled: !authLoading && isAuthenticated && !!token && !!tenantId,
    // Smart retry logic
    retry: (failureCount, error) => {
      // Don't retry auth errors
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
 * Hook to fetch single batch
 */
export function useBatch(id: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'batches', 'detail', id),
    queryFn: async () => {
      const data = await graphqlClient.request<{ batch: Batch }>(
        BATCH_QUERY,
        { id }
      );
      return data.batch;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!id,
  });
}

/**
 * Hook to fetch available tanks for batch allocation
 */
export function useAvailableTanks(options?: {
  siteId?: string;
  departmentId?: string;
  excludeFullTanks?: boolean;
}) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'batches', 'availableTanks', options),
    queryFn: async () => {
      try {
        const data = await graphqlClient.request<{ availableTanks: AvailableTank[] }>(
          AVAILABLE_TANKS_QUERY,
          {
            siteId: options?.siteId,
            departmentId: options?.departmentId,
            excludeFullTanks: options?.excludeFullTanks ?? false,
          }
        );
        return data.availableTanks;
      } catch (error) {
        console.error('[useAvailableTanks] GraphQL error:', error);
        throw error;
      }
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId,
    retry: 1,
  });
}

/**
 * Hook to generate next batch number
 */
export function useGenerateBatchNumber() {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'batches', 'generateNumber'),
    queryFn: async () => {
      const data = await graphqlClient.request<{ generateBatchNumber: string }>(
        GENERATE_BATCH_NUMBER_QUERY
      );
      return data.generateBatchNumber;
    },
    staleTime: 5000, // Short stale time as batch numbers change frequently
    enabled: !!token && !!tenantId,
  });
}

/**
 * Hook to create a new batch
 */
export function useCreateBatch() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateBatchInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ createBatch: Batch }>(
        CREATE_BATCH_MUTATION,
        { input }
      );
      return data.createBatch;
    },
    onSuccess: () => {
      // Invalidate batch list and batch number
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'batches', 'list') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'batches', 'generateNumber') });
    },
  });
}

// ============================================================================
// TANK OPERATION MUTATIONS
// ============================================================================

const RECORD_MORTALITY_MUTATION = `
  mutation RecordMortality($input: RecordMortalityInput!) {
    recordMortality(input: $input) {
      id
      batchNumber
      currentQuantity
      totalMortality
      retentionRate
      mortalityRate
      currentBiomassKg
    }
  }
`;

const RECORD_CULL_MUTATION = `
  mutation RecordCull($input: RecordCullInput!) {
    recordCull(input: $input) {
      id
      batchNumber
      currentQuantity
      cullCount
      retentionRate
      currentBiomassKg
    }
  }
`;

const TRANSFER_BATCH_MUTATION = `
  mutation TransferBatch($input: TransferBatchInput!) {
    transferBatch(input: $input) {
      id
      batchNumber
      currentQuantity
      currentBiomassKg
    }
  }
`;

const RECORD_GRADING_MUTATION = `
  mutation RecordGrading($input: RecordGradingInput!) {
    recordGrading(input: $input) {
      id
      batchNumber
      currentQuantity
      currentBiomassKg
    }
  }
`;

const CREATE_HARVEST_RECORD_MUTATION = `
  mutation CreateHarvestRecord($input: CreateHarvestRecordInput!) {
    createHarvestRecord(input: $input) {
      id
      recordCode
      lotNumber
      quantityHarvested
      totalBiomass
      averageWeight
      qualityGrade
      status
    }
  }
`;

// FARM-HIGH-052: the farm-service now REQUIRES an at-most-once envelope
// (clientCommandId + payloadHash) on every stock-mutating mutation, matching the
// AquaMobil offline-queue contract. The desktop web attaches it here so a
// double-click / retried submit is deduped server-side instead of
// double-decrementing inventory.
/**
 * Deterministic, RECURSIVELY key-sorted stringify — the canonical form the
 * server's at-most-once payloadHash guard hashes.
 *
 * FARM-LOW-141: this MUST stay byte-identical to AquaMobil's stableStringify
 * (web/apps/aquamobil/src/pwa/offline-queue.ts) so the web and mobile clients
 * hash one dedup contract the same way. The previous web impl sorted only the
 * TOP-LEVEL keys, so a nested object would have hashed differently from mobile —
 * inert while payloads are flat, a silent drift trap the moment one nests.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function hashPayload(payload: object): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(stableStringify(payload)),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Per-submit-intent idempotency envelope. The clientCommandId is held STABLE in a
 * ref until a submit succeeds, so a double-click or a network-retried submit reuses
 * the same id (the server's at-most-once ledger dedups it); reset() after success
 * lets the next genuine submit mint a fresh id. Online-only — there is no offline
 * queue on the desktop web.
 */
function useStockCommandEnvelope(): {
  attach: <T extends object>(input: T) => Promise<T & { clientCommandId: string; payloadHash: string }>;
  reset: () => void;
} {
  const commandIdRef = useRef<string | null>(null);
  async function attach<T extends object>(
    input: T,
  ): Promise<T & { clientCommandId: string; payloadHash: string }> {
    commandIdRef.current ??= crypto.randomUUID();
    return { ...input, clientCommandId: commandIdRef.current, payloadHash: await hashPayload(input) };
  }
  function reset(): void {
    commandIdRef.current = null;
  }
  return { attach, reset };
}

/**
 * Hook to record mortality in a tank
 */
export function useRecordMortality() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();
  const envelope = useStockCommandEnvelope();

  return useMutation({
    mutationFn: async (input: RecordMortalityInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ recordMortality: Batch }>(
        RECORD_MORTALITY_MUTATION,
        { input: await envelope.attach(input) }
      );
      return data.recordMortality;
    },
    onSuccess: () => {
      // FARM-HIGH-052: release the per-submit clientCommandId so the next genuine
      // submit mints a fresh one (a double-click before this point reused it).
      envelope.reset();
      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'batches') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'tankBatches') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'tanks') });
    },
  });
}

/**
 * Hook to record cull in a tank
 */
export function useRecordCull() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();
  const envelope = useStockCommandEnvelope();

  return useMutation({
    mutationFn: async (input: RecordCullInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ recordCull: Batch }>(
        RECORD_CULL_MUTATION,
        { input: await envelope.attach(input) }
      );
      return data.recordCull;
    },
    onSuccess: () => {
      // FARM-HIGH-052: release the per-submit clientCommandId (see useRecordMortality).
      envelope.reset();
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'batches') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'tankBatches') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'tanks') });
    },
  });
}

/**
 * Hook to transfer batch between tanks
 */
export function useTransferBatch() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();
  const envelope = useStockCommandEnvelope();

  return useMutation({
    mutationFn: async (input: TransferBatchInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ transferBatch: Batch }>(
        TRANSFER_BATCH_MUTATION,
        { input: await envelope.attach(input) }
      );
      return data.transferBatch;
    },
    onSuccess: () => {
      // FARM-HIGH-052: release the per-submit clientCommandId (see useRecordMortality).
      envelope.reset();
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'batches') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'tankBatches') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'tanks') });
    },
  });
}

/**
 * Hook to record a grading operation (FARM-MEDIUM-117).
 *
 * Server-side every output is its own TransferBatchCommand (reason 'grading'),
 * so every output carries its OWN at-most-once envelope. Output command ids are
 * held stable per output index until a submit succeeds — a retried submit after
 * a mid-sequence failure reuses the ids, so already-committed outputs are deduped
 * by the server's at-most-once ledger instead of double-moving fish.
 */
export function useRecordGrading() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();
  // FARM-MEDIUM-129: per-output ids keyed by the stable row identity, so a
  // resubmit of only the not-yet-committed rows reuses each surviving row's id
  // instead of shifting ids by array position and colliding on payloadHash.
  const outputCommandIdsRef = useRef<Map<string, string>>(new Map());

  return useMutation({
    mutationFn: async (input: RecordGradingInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const idsByRow = outputCommandIdsRef.current;
      const outputs = await Promise.all(
        input.outputs.map(async ({ rowKey, ...serverOutput }) => {
          const clientCommandId = idsByRow.get(rowKey) ?? crypto.randomUUID();
          idsByRow.set(rowKey, clientCommandId);
          // FARM-LOW-137: grading carries ONLY per-output envelopes — the
          // resolver reads no operation-level clientCommandId, so we do not
          // attach one here (it would be a redundant hash implying dedup that
          // does not exist).
          return {
            ...serverOutput,
            clientCommandId,
            payloadHash: await hashPayload(serverOutput),
          };
        }),
      );
      const data = await graphqlClient.request<{ recordGrading: Batch }>(
        RECORD_GRADING_MUTATION,
        { input: { ...input, outputs } }
      );
      return data.recordGrading;
    },
    onSuccess: () => {
      // FARM-HIGH-052: release the per-row clientCommandIds so the next genuine
      // grading mints fresh ones (see useRecordMortality).
      outputCommandIdsRef.current = new Map();
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'batches') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'tankBatches') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'tanks') });
    },
  });
}

/**
 * Hook to create harvest record
 */
export function useCreateHarvestRecord() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateHarvestRecordInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ createHarvestRecord: any }>(
        CREATE_HARVEST_RECORD_MUTATION,
        { input }
      );
      return data.createHarvestRecord;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'batches') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'tankBatches') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'tanks') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'harvestRecords') });
    },
  });
}

// ============================================================================
// TIER 1 BATCH LIFECYCLE MUTATIONS (Faz 3)
// ============================================================================

const UPDATE_BATCH_STATUS_MUTATION = `
  mutation UpdateBatchStatus($id: ID!, $status: BatchStatus!, $reason: String) {
    updateBatchStatus(id: $id, status: $status, reason: $reason) {
      id
      batchNumber
      status
    }
  }
`;

const CLOSE_BATCH_MUTATION = `
  mutation CloseBatch(
    $id: ID!,
    $reason: BatchCloseReason!,
    $notes: String,
    $acknowledgeActiveTreatments: Boolean
  ) {
    closeBatch(
      id: $id,
      reason: $reason,
      notes: $notes,
      acknowledgeActiveTreatments: $acknowledgeActiveTreatments
    ) {
      id
      batchNumber
      status
    }
  }
`;

const ALLOCATE_BATCH_TO_TANK_MUTATION = `
  mutation AllocateBatchToTank($input: AllocateToTankInput!) {
    allocateBatchToTank(input: $input) {
      id
      batchNumber
      currentQuantity
      currentBiomassKg
    }
  }
`;

export interface UpdateBatchStatusInput {
  id: string;
  status: BatchStatus;
  reason?: string;
}

export interface CloseBatchInput {
  id: string;
  reason: BatchCloseReason;
  notes?: string;
  acknowledgeActiveTreatments?: boolean;
}

// ---------------------------------------------------------------------------
// updateBatch — Tier 2 #1 (Scope C PR-2)
// Mirrors the backend `UpdateBatchInput` (apps/farm-service/src/batch/dto/
// batch-resolver.dto.ts:53). Backend's input set is exactly four fields:
//   id (required), name?, expectedHarvestDate?, targetFCR?, notes?.
// status changes go through `useUpdateBatchStatus`; full lifecycle
// transitions through `useCloseBatch`.
// ---------------------------------------------------------------------------

const UPDATE_BATCH_MUTATION = `
  mutation UpdateBatch($input: UpdateBatchInput!) {
    updateBatch(input: $input) {
      id
      batchNumber
      name
      expectedHarvestDate
      fcr
      notes
      updatedAt
    }
  }
`;

export interface UpdateBatchInput {
  id: string;
  name?: string;
  /** ISO-8601 date string (YYYY-MM-DD or full ISO with TZ). */
  expectedHarvestDate?: string;
  targetFCR?: number;
  notes?: string;
}

/**
 * Hook to update batch metadata (name, expected harvest date,
 * target FCR, notes). Status / quantity / biomass changes go
 * through the dedicated lifecycle mutations.
 */
export function useUpdateBatch() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateBatchInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ updateBatch: Batch }>(
        UPDATE_BATCH_MUTATION,
        { input },
      );
      return data.updateBatch;
    },
    onSuccess: (updatedBatch) => {
      // Invalidate the list AND the specific detail key so the
      // BatchDetailPage re-renders with the new values immediately.
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, 'batches'),
      });
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, 'batches', 'detail', updatedBatch.id),
      });
    },
  });
}

/**
 * Hook to transition a batch to a new status (QUARANTINE → ACTIVE,
 * GROWING → PRE_HARVEST, etc.). The backend `updateBatchStatus`
 * resolver validates allowed transitions per BatchStatusStateMachine.
 */
export function useUpdateBatchStatus() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateBatchStatusInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ updateBatchStatus: Batch }>(
        UPDATE_BATCH_STATUS_MUTATION,
        { id: input.id, status: input.status, reason: input.reason },
      );
      return data.updateBatchStatus;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'batches') });
    },
  });
}

/**
 * Hook to close a batch. The backend blocks closing while any
 * active medicine-withdrawal treatment remains unless the caller
 * passes `acknowledgeActiveTreatments: true` — in which case the
 * override is written to the audit log.
 *
 * On rejection, the backend surfaces the blocking treatments in
 * the error path; the caller should parse and show them so the
 * operator can confirm.
 */
export function useCloseBatch() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CloseBatchInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ closeBatch: Batch }>(
        CLOSE_BATCH_MUTATION,
        {
          id: input.id,
          reason: input.reason,
          notes: input.notes,
          acknowledgeActiveTreatments: input.acknowledgeActiveTreatments,
        },
      );
      return data.closeBatch;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'batches') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'tanks') });
    },
  });
}

/**
 * Hook to allocate a batch to a tank. The backend enforces the
 * three-axis capacity invariant (status/biomass/density) via
 * TankCapacityService — `admin-override` mode for TENANT_ADMIN,
 * `hard` for everyone else (a TS2532-safe allocation path).
 */
export function useAllocateBatchToTank() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();
  const envelope = useStockCommandEnvelope();

  return useMutation({
    mutationFn: async (input: AllocateBatchToTankInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ allocateBatchToTank: Batch }>(
        ALLOCATE_BATCH_TO_TANK_MUTATION,
        { input: await envelope.attach(input) },
      );
      return data.allocateBatchToTank;
    },
    onSuccess: () => {
      // FARM-HIGH-052: release the per-submit clientCommandId (see useRecordMortality).
      envelope.reset();
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'batches') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'tankBatches') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'tanks') });
    },
  });
}
