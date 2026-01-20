/**
 * Batch hooks for farm-module
 * Handles CRUD operations for batches via GraphQL API
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient } from '@aquaculture/shared-ui';

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

// Tank Operation Types
export type MortalityReason =
  | 'DISEASE'
  | 'WATER_QUALITY'
  | 'STRESS'
  | 'HANDLING'
  | 'TEMPERATURE'
  | 'OXYGEN'
  | 'UNKNOWN'
  | 'OTHER';

export type CullReason =
  | 'SMALL_SIZE'
  | 'DEFORMED'
  | 'SICK'
  | 'POOR_GROWTH'
  | 'GRADING'
  | 'OTHER';

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
const BATCH_LIST_QUERY = `
  query Batches($tenantId: String!, $filter: BatchFilterInput, $page: Int, $limit: Int, $sortBy: String, $sortOrder: String) {
    batches(tenantId: $tenantId, filter: $filter, page: $page, limit: $limit, sortBy: $sortBy, sortOrder: $sortOrder) {
      items {
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
  query Batch($tenantId: String!, $id: ID!) {
    batch(tenantId: $tenantId, id: $id) {
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
  query AvailableTanks($tenantId: String!, $siteId: ID, $departmentId: ID, $excludeFullTanks: Boolean) {
    availableTanks(tenantId: $tenantId, siteId: $siteId, departmentId: $departmentId, excludeFullTanks: $excludeFullTanks) {
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
  query GenerateBatchNumber($tenantId: String!) {
    generateBatchNumber(tenantId: $tenantId)
  }
`;

const CREATE_BATCH_MUTATION = `
  mutation CreateBatch($tenantId: String!, $userId: String!, $input: CreateBatchInput!) {
    createBatch(tenantId: $tenantId, userId: $userId, input: $input) {
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
    queryKey: ['batches', 'list', tenantId, filter, options],
    queryFn: async () => {
      // Double-check tenantId before request
      if (!tenantId) {
        throw new Error('Tenant context required');
      }

      const data = await graphqlClient.request<{ batches: BatchListResponse }>(
        BATCH_LIST_QUERY,
        {
          tenantId,
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
    queryKey: ['batches', 'detail', id],
    queryFn: async () => {
      const data = await graphqlClient.request<{ batch: Batch }>(
        BATCH_QUERY,
        { tenantId, id }
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
    queryKey: ['batches', 'availableTanks', options],
    queryFn: async () => {
      const data = await graphqlClient.request<{ availableTanks: AvailableTank[] }>(
        AVAILABLE_TANKS_QUERY,
        {
          tenantId,
          siteId: options?.siteId,
          departmentId: options?.departmentId,
          excludeFullTanks: options?.excludeFullTanks ?? false,
        }
      );
      return data.availableTanks;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId,
  });
}

/**
 * Hook to generate next batch number
 */
export function useGenerateBatchNumber() {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['batches', 'generateNumber'],
    queryFn: async () => {
      const data = await graphqlClient.request<{ generateBatchNumber: string }>(
        GENERATE_BATCH_NUMBER_QUERY,
        { tenantId }
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
  const { token, tenantId, user } = useAuth();
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
        {
          tenantId,
          userId: user?.id || 'unknown',
          input,
        }
      );
      return data.createBatch;
    },
    onSuccess: () => {
      // Invalidate batch list and batch number
      queryClient.invalidateQueries({ queryKey: ['batches', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['batches', 'generateNumber'] });
    },
  });
}

// ============================================================================
// TANK OPERATION MUTATIONS
// ============================================================================

const RECORD_MORTALITY_MUTATION = `
  mutation RecordMortality($tenantId: String!, $userId: String!, $input: RecordMortalityInput!) {
    recordMortality(tenantId: $tenantId, userId: $userId, input: $input) {
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
  mutation RecordCull($tenantId: String!, $userId: String!, $input: RecordCullInput!) {
    recordCull(tenantId: $tenantId, userId: $userId, input: $input) {
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
  mutation TransferBatch($tenantId: String!, $userId: String!, $input: TransferBatchInput!) {
    transferBatch(tenantId: $tenantId, userId: $userId, input: $input) {
      id
      batchNumber
      currentQuantity
      currentBiomassKg
    }
  }
`;

const CREATE_HARVEST_RECORD_MUTATION = `
  mutation CreateHarvestRecord($tenantId: String!, $userId: String!, $input: CreateHarvestRecordInput!) {
    createHarvestRecord(tenantId: $tenantId, userId: $userId, input: $input) {
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

/**
 * Hook to record mortality in a tank
 */
export function useRecordMortality() {
  const { token, tenantId, user } = useAuth();
  const queryClient = useQueryClient();

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
        {
          tenantId,
          userId: user?.id || 'unknown',
          input,
        }
      );
      return data.recordMortality;
    },
    onSuccess: () => {
      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: ['batches'] });
      queryClient.invalidateQueries({ queryKey: ['tankBatches'] });
      queryClient.invalidateQueries({ queryKey: ['tanks'] });
    },
  });
}

/**
 * Hook to record cull in a tank
 */
export function useRecordCull() {
  const { token, tenantId, user } = useAuth();
  const queryClient = useQueryClient();

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
        {
          tenantId,
          userId: user?.id || 'unknown',
          input,
        }
      );
      return data.recordCull;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['batches'] });
      queryClient.invalidateQueries({ queryKey: ['tankBatches'] });
      queryClient.invalidateQueries({ queryKey: ['tanks'] });
    },
  });
}

/**
 * Hook to transfer batch between tanks
 */
export function useTransferBatch() {
  const { token, tenantId, user } = useAuth();
  const queryClient = useQueryClient();

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
        {
          tenantId,
          userId: user?.id || 'unknown',
          input,
        }
      );
      return data.transferBatch;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['batches'] });
      queryClient.invalidateQueries({ queryKey: ['tankBatches'] });
      queryClient.invalidateQueries({ queryKey: ['tanks'] });
    },
  });
}

/**
 * Hook to create harvest record
 */
export function useCreateHarvestRecord() {
  const { token, tenantId, user } = useAuth();
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
        {
          tenantId,
          userId: user?.id || 'unknown',
          input,
        }
      );
      return data.createHarvestRecord;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['batches'] });
      queryClient.invalidateQueries({ queryKey: ['tankBatches'] });
      queryClient.invalidateQueries({ queryKey: ['tanks'] });
      queryClient.invalidateQueries({ queryKey: ['harvestRecords'] });
    },
  });
}
