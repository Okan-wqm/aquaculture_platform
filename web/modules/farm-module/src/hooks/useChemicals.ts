/**
 * Chemicals hooks for farm-module
 * Handles CRUD operations for chemicals via GraphQL API
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient } from '@aquaculture/shared-ui';

// Enums - Values must be UPPERCASE to match GraphQL enum keys
export enum ChemicalType {
  DISINFECTANT = 'DISINFECTANT',
  TREATMENT = 'TREATMENT',
  WATER_CONDITIONER = 'WATER_CONDITIONER',
  ANTIBIOTIC = 'ANTIBIOTIC',
  ANTIPARASITIC = 'ANTIPARASITIC',
  PROBIOTIC = 'PROBIOTIC',
  VITAMIN = 'VITAMIN',
  MINERAL = 'MINERAL',
  ANESTHETIC = 'ANESTHETIC',
  PH_ADJUSTER = 'PH_ADJUSTER',
  ALGAECIDE = 'ALGAECIDE',
  OTHER = 'OTHER',
}

export enum ChemicalStatus {
  AVAILABLE = 'AVAILABLE',
  LOW_STOCK = 'LOW_STOCK',
  OUT_OF_STOCK = 'OUT_OF_STOCK',
  EXPIRED = 'EXPIRED',
  DISCONTINUED = 'DISCONTINUED',
}

// Document type enum
export enum ChemicalDocumentType {
  MSDS = 'msds',
  LABEL = 'label',
  PROTOCOL = 'protocol',
  CERTIFICATE = 'certificate',
  OTHER = 'other',
}

// Types
export interface ChemicalTypeResponse {
  id: string;
  name: string;
  code: string;
  description?: string;
  icon?: string;
  isActive: boolean;
  sortOrder: number;
}

export interface ChemicalDocument {
  id: string;
  name: string;
  type: ChemicalDocumentType;
  url: string;
  uploadedAt: string;
  uploadedBy?: string;
}

export interface SupplierBasic {
  id: string;
  name: string;
}

export interface UsageProtocol {
  dosage: string;
  applicationMethod: string;
  frequency?: string;
  duration?: string;
  withdrawalPeriod?: number;
  targetSpecies?: string[];
  targetConditions?: string[];
  contraindications?: string[];
  precautions?: string[];
  notes?: string;
}

export interface SafetyInfo {
  hazardClass?: string;
  signalWord?: string;
  hazardStatements?: string[];
  precautionaryStatements?: string[];
  firstAid?: {
    inhalation?: string;
    skinContact?: string;
    eyeContact?: string;
    ingestion?: string;
  };
  storageConditions?: string;
  disposalMethod?: string;
  msdsUrl?: string;
}

export interface Chemical {
  id: string;
  tenantId: string;
  siteId?: string;
  name: string;
  code: string;
  type: ChemicalType;
  description?: string;
  brand?: string;
  activeIngredient?: string;
  concentration?: string;
  formulation?: string;
  supplierId?: string;
  supplier?: SupplierBasic;
  status: ChemicalStatus;
  quantity: number;
  minStock: number;
  unit: string;
  usageProtocol?: UsageProtocol;
  safetyInfo?: SafetyInfo;
  storageRequirements?: string;
  shelfLifeMonths?: number;
  expiryDate?: string;
  usageAreas?: string[];
  documents?: ChemicalDocument[];
  unitPrice?: number;
  currency: string;
  notes?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
}

export interface CreateChemicalInput {
  name: string;
  code: string;
  type: ChemicalType;
  siteId: string;
  unit: string;
  description?: string;
  brand?: string;
  activeIngredient?: string;
  concentration?: string;
  formulation?: string;
  supplierId?: string;
  status?: ChemicalStatus;
  quantity?: number;
  minStock?: number;
  usageProtocol?: UsageProtocol;
  safetyInfo?: SafetyInfo;
  storageRequirements?: string;
  shelfLifeMonths?: number;
  expiryDate?: string;
  usageAreas?: string[];
  unitPrice?: number;
  currency?: string;
  notes?: string;
}

export interface UpdateChemicalInput extends Partial<CreateChemicalInput> {
  id: string;
  isActive?: boolean;
}

interface PaginatedResponse {
  items: Chemical[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// GraphQL queries
const CHEMICALS_LIST_QUERY = `
  query Chemicals($filter: ChemicalFilterInput, $pagination: PaginationInput) {
    chemicals(filter: $filter, pagination: $pagination) {
      items {
        id
        tenantId
        name
        code
        type
        description
        brand
        activeIngredient
        concentration
        formulation
        supplierId
        status
        quantity
        minStock
        unit
        usageProtocol {
          dosage
          applicationMethod
          frequency
          duration
          withdrawalPeriod
          targetSpecies
          precautions
          notes
        }
        safetyInfo {
          hazardClass
          signalWord
          storageConditions
          msdsUrl
        }
        storageRequirements
        shelfLifeMonths
        expiryDate
        usageAreas
        documents {
          id
          name
          type
          url
          uploadedAt
          uploadedBy
        }
        unitPrice
        currency
        notes
        isActive
        createdAt
        updatedAt
      }
      total
      page
      limit
      totalPages
    }
  }
`;

const CHEMICAL_QUERY = `
  query Chemical($id: ID!) {
    chemical(id: $id) {
      id
      tenantId
      name
      code
      type
      description
      brand
      activeIngredient
      concentration
      formulation
      supplierId
      status
      quantity
      minStock
      unit
      usageProtocol {
        dosage
        applicationMethod
        frequency
        duration
        withdrawalPeriod
        targetSpecies
        precautions
        notes
      }
      safetyInfo {
        hazardClass
        signalWord
        storageConditions
        msdsUrl
      }
      storageRequirements
      shelfLifeMonths
      expiryDate
      usageAreas
      documents {
        id
        name
        type
        url
        uploadedAt
        uploadedBy
      }
      unitPrice
      currency
      notes
      isActive
      createdAt
      updatedAt
    }
  }
`;

const CREATE_CHEMICAL_MUTATION = `
  mutation CreateChemical($input: CreateChemicalInput!) {
    createChemical(input: $input) {
      id
      name
      code
      type
      status
      isActive
    }
  }
`;

const UPDATE_CHEMICAL_MUTATION = `
  mutation UpdateChemical($input: UpdateChemicalInput!) {
    updateChemical(input: $input) {
      id
      name
      code
      type
      status
      isActive
    }
  }
`;

const DELETE_CHEMICAL_MUTATION = `
  mutation DeleteChemical($id: ID!) {
    deleteChemical(id: $id)
  }
`;

const CHEMICAL_TYPES_QUERY = `
  query ChemicalTypes {
    chemicalTypes {
      id
      name
      code
      description
      icon
      isActive
      sortOrder
    }
  }
`;

const ADD_CHEMICAL_DOCUMENT_MUTATION = `
  mutation AddChemicalDocument($input: AddChemicalDocumentInput!) {
    addChemicalDocument(input: $input) {
      id
      documents {
        id
        name
        type
        url
        uploadedAt
        uploadedBy
      }
    }
  }
`;

const REMOVE_CHEMICAL_DOCUMENT_MUTATION = `
  mutation RemoveChemicalDocument($chemicalId: ID!, $documentId: ID!) {
    removeChemicalDocument(chemicalId: $chemicalId, documentId: $documentId)
  }
`;

// graphqlClient from shared-ui handles token/tenantId automatically

/**
 * Hook to fetch chemicals list
 */
export function useChemicalList(filter?: {
  type?: ChemicalType;
  status?: ChemicalStatus;
  isActive?: boolean;
  supplierId?: string;
  search?: string;
}) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['chemicals', 'list', filter],
    queryFn: async () => {
      const data = await graphqlClient.request<{ chemicals: PaginatedResponse }>(
        CHEMICALS_LIST_QUERY,
        { filter }
      );
      return data.chemicals;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId,
  });
}

/**
 * Hook to fetch single chemical
 */
export function useChemical(id: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['chemicals', 'detail', id],
    queryFn: async () => {
      const data = await graphqlClient.request<{ chemical: Chemical }>(
        CHEMICAL_QUERY,
        { id }
      );
      return data.chemical;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!id,
  });
}

/**
 * Hook to create chemical
 */
export function useCreateChemical() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateChemicalInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ createChemical: Chemical }>(
        CREATE_CHEMICAL_MUTATION,
        { input }
      );
      return data.createChemical;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chemicals', 'list'] });
    },
  });
}

/**
 * Hook to update chemical
 */
export function useUpdateChemical() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateChemicalInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ updateChemical: Chemical }>(
        UPDATE_CHEMICAL_MUTATION,
        { input }
      );
      return data.updateChemical;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['chemicals', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['chemicals', 'detail', variables.id] });
    },
  });
}

/**
 * Hook to delete chemical
 */
export function useDeleteChemical() {
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
      const data = await graphqlClient.request<{ deleteChemical: boolean }>(
        DELETE_CHEMICAL_MUTATION,
        { id }
      );
      return data.deleteChemical;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chemicals', 'list'] });
    },
  });
}

/**
 * Hook to fetch chemical types (global, not tenant-specific)
 */
export function useChemicalTypes() {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['chemicals', 'types'],
    queryFn: async () => {
      const data = await graphqlClient.request<{ chemicalTypes: ChemicalTypeResponse[] }>(
        CHEMICAL_TYPES_QUERY,
        {}
      );
      return data.chemicalTypes;
    },
    staleTime: 60000, // Types don't change often
    enabled: !!token,
  });
}

// ============================================================================
// DOCUMENT HOOKS
// ============================================================================

export interface UploadChemicalDocumentParams {
  file: File;
  chemicalId: string;
  documentName: string;
  documentType: ChemicalDocumentType;
}

export interface UploadChemicalDocumentResult {
  documentId: string;
  documentName: string;
  documentType: ChemicalDocumentType;
  url: string;
  path: string;
  uploadedAt: string;
  uploadedBy: string;
}

/**
 * Hook to upload a document file to MinIO and register it with a chemical
 * This is a two-step process:
 * 1. Upload file to MinIO via REST API
 * 2. Add document reference to chemical via GraphQL
 */
export function useUploadChemicalDocument() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: UploadChemicalDocumentParams): Promise<UploadChemicalDocumentResult> => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }

      const { file, chemicalId, documentName, documentType } = params;

      // Step 1: Upload file to MinIO via REST endpoint
      const formData = new FormData();
      formData.append('file', file);
      formData.append('chemicalId', chemicalId);
      formData.append('documentName', documentName);
      formData.append('documentType', documentType);

      const uploadResponse = await fetch('/api/upload/chemical-document', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'x-tenant-id': tenantId,
        },
        body: formData,
      });

      if (!uploadResponse.ok) {
        const error = await uploadResponse.json().catch(() => ({ message: 'Upload failed' }));
        throw new Error(error.message || 'Failed to upload document');
      }

      const uploadResult = await uploadResponse.json();

      // Step 2: Add document reference to chemical via GraphQL
      const graphqlResult = await graphqlClient.request<{ addChemicalDocument: Chemical }>(
        ADD_CHEMICAL_DOCUMENT_MUTATION,
        {
          input: {
            chemicalId,
            documentId: uploadResult.documentId,
            documentName: uploadResult.documentName,
            documentType: uploadResult.documentType,
            url: uploadResult.url,
            uploadedAt: uploadResult.uploadedAt,
          },
        }
      );

      return {
        documentId: uploadResult.documentId,
        documentName: uploadResult.documentName,
        documentType: uploadResult.documentType,
        url: uploadResult.url,
        path: uploadResult.path,
        uploadedAt: uploadResult.uploadedAt,
        uploadedBy: uploadResult.uploadedBy,
      };
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['chemicals', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['chemicals', 'detail', variables.chemicalId] });
    },
  });
}

export interface AddChemicalDocumentInput {
  chemicalId: string;
  documentId: string;
  documentName: string;
  documentType: ChemicalDocumentType;
  url: string;
  uploadedAt: string;
}

/**
 * Hook to add document reference to chemical (used when file is already uploaded)
 */
export function useAddChemicalDocument() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: AddChemicalDocumentInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ addChemicalDocument: Chemical }>(
        ADD_CHEMICAL_DOCUMENT_MUTATION,
        { input }
      );
      return data.addChemicalDocument;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['chemicals', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['chemicals', 'detail', variables.chemicalId] });
    },
  });
}

export interface RemoveChemicalDocumentParams {
  chemicalId: string;
  documentId: string;
  filename: string;
}

/**
 * Hook to remove a document from a chemical
 * This removes both the file from MinIO and the reference from the chemical
 */
export function useRemoveChemicalDocument() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: RemoveChemicalDocumentParams): Promise<boolean> => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }

      const { chemicalId, documentId, filename } = params;

      // Step 1: Delete file from MinIO via REST endpoint
      const deleteResponse = await fetch(
        `/api/upload/chemical-document/${chemicalId}/${documentId}/${encodeURIComponent(filename)}`,
        {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${token}`,
            'x-tenant-id': tenantId,
          },
        }
      );

      if (!deleteResponse.ok) {
        const error = await deleteResponse.json().catch(() => ({ message: 'Delete failed' }));
        throw new Error(error.message || 'Failed to delete document file');
      }

      // Step 2: Remove document reference from chemical via GraphQL
      const data = await graphqlClient.request<{ removeChemicalDocument: boolean }>(
        REMOVE_CHEMICAL_DOCUMENT_MUTATION,
        { chemicalId, documentId }
      );

      return data.removeChemicalDocument;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['chemicals', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['chemicals', 'detail', variables.chemicalId] });
    },
  });
}

/**
 * Hook to get a presigned URL for downloading a document
 */
export function useGetDocumentUrl() {
  const { token, tenantId } = useAuth();

  return useMutation({
    mutationFn: async (path: string): Promise<{ url: string; expiresAt: string }> => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }

      const response = await fetch('/api/upload/presigned-url', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'x-tenant-id': tenantId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path, expirySeconds: 3600 }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ message: 'Failed to get URL' }));
        throw new Error(error.message || 'Failed to get document URL');
      }

      return response.json();
    },
  });
}
