/**
 * Feeds hooks for farm-module
 * Handles CRUD operations for feeds via GraphQL API
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient } from '@aquaculture/shared-ui';

// Enums
export enum FeedType {
  STARTER = 'starter',
  GROWER = 'grower',
  FINISHER = 'finisher',
  BROODSTOCK = 'broodstock',
  MEDICATED = 'medicated',
  LARVAL = 'larval',
  FRY = 'fry',
  OTHER = 'other',
}

export enum FloatingType {
  FLOATING = 'floating',
  SINKING = 'sinking',
  SLOW_SINKING = 'slow_sinking',
}

export enum FeedStatus {
  AVAILABLE = 'available',
  LOW_STOCK = 'low_stock',
  OUT_OF_STOCK = 'out_of_stock',
  EXPIRED = 'expired',
  DISCONTINUED = 'discontinued',
}

// Types
export interface FeedTypeResponse {
  id: string;
  name: string;
  code: string;
  description?: string;
  icon?: string;
  isActive: boolean;
  sortOrder: number;
}

export interface NutritionalContent {
  crudeProtein?: number;
  crudeFat?: number;
  crudeFiber?: number;
  crudeAsh?: number;
  moisture?: number;
  energy?: number;
  energyUnit?: 'kcal' | 'MJ';
  phosphorus?: number;
  calcium?: number;
  omega3?: number;
  omega6?: number;
  lysine?: number;
  methionine?: number;
  vitamins?: Record<string, number>;
  minerals?: Record<string, number>;
  additionalInfo?: Record<string, unknown>;
  // Yeni alanlar
  nfe?: number;
  grossEnergy?: number;
  digestibleEnergy?: number;
}

export interface FeedingCurvePoint {
  fishWeightG: number;
  feedingRatePercent: number;
  fcr: number;
}

export interface EnvironmentalImpact {
  co2EqWithLuc?: number;
  co2EqWithoutLuc?: number;
}

export interface FeedDocument {
  id?: string;
  name: string;
  type: 'datasheet' | 'certificate' | 'label' | 'analysis' | 'other';
  url: string;
  uploadedAt?: string;
  uploadedBy?: string;
}

export interface FeedSupplierBasic {
  id: string;
  name: string;
  code?: string;
}

export interface FeedingTableEntry {
  temperatureMin: number;
  temperatureMax: number;
  temperatureUnit: 'celsius' | 'fahrenheit';
  weightRanges: Array<{
    minWeight: number;
    maxWeight: number;
    weightUnit: 'gram' | 'kg';
    feedPercent: number;
    feedingFrequency: number;
    notes?: string;
  }>;
}

export interface FeedingTable {
  species: string;
  stage: FeedType;
  entries: FeedingTableEntry[];
  fcr?: number;
  notes?: string;
}

export interface Feed {
  id: string;
  tenantId: string;
  siteId?: string;
  name: string;
  code: string;
  type: FeedType;
  description?: string;
  brand?: string;
  manufacturer?: string;
  supplierId?: string;
  targetSpecies?: string;
  pelletSize?: number;
  floatingType: FloatingType;
  nutritionalContent?: NutritionalContent;
  status: FeedStatus;
  quantity: number;
  minStock: number;
  unit: string;
  storageRequirements?: string;
  shelfLifeMonths?: number;
  expiryDate?: string;
  pricePerKg?: number;
  currency: string;
  notes?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
  // Yeni alanlar
  pelletSizeLabel?: string;
  productStage?: string;
  composition?: string;
  unitSize?: string;
  unitPrice?: number;
  environmentalImpact?: EnvironmentalImpact;
  feedingCurve?: FeedingCurvePoint[];
  documents?: FeedDocument[];
}

export interface CreateFeedInput {
  name: string;
  code: string;
  type: FeedType;
  siteId: string;
  description?: string;
  brand?: string;
  manufacturer?: string;
  supplierId?: string;
  targetSpecies?: string;
  pelletSize?: number;
  floatingType?: FloatingType;
  nutritionalContent?: NutritionalContent;
  status?: FeedStatus;
  quantity?: number;
  minStock?: number;
  unit?: string;
  storageRequirements?: string;
  shelfLifeMonths?: number;
  expiryDate?: string;
  pricePerKg?: number;
  currency?: string;
  notes?: string;
  // Yeni alanlar
  pelletSizeLabel?: string;
  productStage?: string;
  composition?: string;
  unitSize?: string;
  unitPrice?: number;
  environmentalImpact?: EnvironmentalImpact;
  feedingCurve?: FeedingCurvePoint[];
  documents?: FeedDocument[];
}

export interface UpdateFeedInput extends Partial<CreateFeedInput> {
  id: string;
  isActive?: boolean;
}

interface PaginatedResponse {
  items: Feed[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// GraphQL queries
const FEEDS_LIST_QUERY = `
  query Feeds($filter: FeedFilterInput, $pagination: PaginationInput) {
    feeds(filter: $filter, pagination: $pagination) {
      items {
        id
        tenantId
        name
        code
        type
        description
        brand
        manufacturer
        supplierId
        targetSpecies
        pelletSize
        floatingType
        nutritionalContent {
          crudeProtein
          crudeFat
          crudeFiber
          crudeAsh
          moisture
          energy
          energyUnit
          phosphorus
          calcium
          omega3
          omega6
          nfe
          grossEnergy
          digestibleEnergy
        }
        status
        quantity
        minStock
        unit
        storageRequirements
        shelfLifeMonths
        expiryDate
        pricePerKg
        currency
        notes
        isActive
        createdAt
        updatedAt
        pelletSizeLabel
        productStage
        composition
        unitSize
        unitPrice
        environmentalImpact {
          co2EqWithLuc
          co2EqWithoutLuc
        }
        feedingCurve {
          fishWeightG
          feedingRatePercent
          fcr
        }
        documents {
          id
          name
          type
          url
          uploadedAt
        }
      }
      total
      page
      limit
      totalPages
    }
  }
`;

const FEED_QUERY = `
  query Feed($id: ID!) {
    feed(id: $id) {
      id
      tenantId
      name
      code
      type
      description
      brand
      manufacturer
      supplierId
      targetSpecies
      pelletSize
      floatingType
      nutritionalContent {
        crudeProtein
        crudeFat
        crudeFiber
        crudeAsh
        moisture
        energy
        energyUnit
        phosphorus
        calcium
        omega3
        omega6
        nfe
        grossEnergy
        digestibleEnergy
      }
      status
      quantity
      minStock
      unit
      storageRequirements
      shelfLifeMonths
      expiryDate
      pricePerKg
      currency
      notes
      isActive
      createdAt
      updatedAt
      pelletSizeLabel
      productStage
      composition
      unitSize
      unitPrice
      environmentalImpact {
        co2EqWithLuc
        co2EqWithoutLuc
      }
      feedingCurve {
        fishWeightG
        feedingRatePercent
        fcr
      }
      documents {
        id
        name
        type
        url
        uploadedAt
      }
    }
  }
`;

const CREATE_FEED_MUTATION = `
  mutation CreateFeed($input: CreateFeedInput!) {
    createFeed(input: $input) {
      id
      name
      code
      type
      status
      isActive
    }
  }
`;

const UPDATE_FEED_MUTATION = `
  mutation UpdateFeed($input: UpdateFeedInput!) {
    updateFeed(input: $input) {
      id
      name
      code
      type
      status
      isActive
    }
  }
`;

const DELETE_FEED_MUTATION = `
  mutation DeleteFeed($id: ID!) {
    deleteFeed(id: $id)
  }
`;

const FEED_TYPES_QUERY = `
  query FeedTypes {
    feedTypes {
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

const FEED_SUPPLIERS_QUERY = `
  query FeedSuppliers {
    feedSuppliers {
      id
      name
      code
    }
  }
`;

// graphqlClient from shared-ui handles token/tenantId automatically

/**
 * Hook to fetch feeds list
 */
export function useFeedList(filter?: {
  type?: FeedType;
  status?: FeedStatus;
  isActive?: boolean;
  supplierId?: string;
  targetSpecies?: string;
  pelletSize?: number;
  search?: string;
}) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['feeds', 'list', filter],
    queryFn: async () => {
      const data = await graphqlClient.request<{ feeds: PaginatedResponse }>(
        FEEDS_LIST_QUERY,
        { filter }
      );
      return data.feeds;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId,
  });
}

/**
 * Hook to fetch single feed
 */
export function useFeed(id: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['feeds', 'detail', id],
    queryFn: async () => {
      const data = await graphqlClient.request<{ feed: Feed }>(
        FEED_QUERY,
        { id }
      );
      return data.feed;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!id,
  });
}

/**
 * Hook to create feed
 */
export function useCreateFeed() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateFeedInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ createFeed: Feed }>(
        CREATE_FEED_MUTATION,
        { input }
      );
      return data.createFeed;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feeds', 'list'] });
    },
  });
}

/**
 * Hook to update feed
 */
export function useUpdateFeed() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateFeedInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ updateFeed: Feed }>(
        UPDATE_FEED_MUTATION,
        { input }
      );
      return data.updateFeed;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['feeds', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['feeds', 'detail', variables.id] });
    },
  });
}

/**
 * Hook to delete feed
 */
export function useDeleteFeed() {
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
      const data = await graphqlClient.request<{ deleteFeed: boolean }>(
        DELETE_FEED_MUTATION,
        { id }
      );
      return data.deleteFeed;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feeds', 'list'] });
    },
  });
}

/**
 * Hook to fetch feed types (global, not tenant-specific)
 */
export function useFeedTypes() {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['feeds', 'types'],
    queryFn: async () => {
      const data = await graphqlClient.request<{ feedTypes: FeedTypeResponse[] }>(
        FEED_TYPES_QUERY,
        {}
      );
      return data.feedTypes;
    },
    staleTime: 60000, // Types don't change often
    enabled: !!token,
  });
}

/**
 * Hook to fetch feed suppliers
 */
export function useFeedSuppliers() {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['feeds', 'suppliers'],
    queryFn: async () => {
      const data = await graphqlClient.request<{ feedSuppliers: FeedSupplierBasic[] }>(
        FEED_SUPPLIERS_QUERY,
        {}
      );
      return data.feedSuppliers;
    },
    staleTime: 60000, // Suppliers don't change often
    enabled: !!token && !!tenantId,
  });
}

/**
 * Besleme oranı hesaplayıcı (interpolasyon ile)
 */
export function calculateFeedingRate(
  weightG: number,
  curve: FeedingCurvePoint[]
): { feedingRate: number; fcr: number } | null {
  if (!curve?.length || !weightG) return null;

  // Noktaları ağırlığa göre sırala
  const sorted = [...curve].sort((a, b) => a.fishWeightG - b.fishWeightG);

  // Exact match
  const exact = sorted.find(p => p.fishWeightG === weightG);
  if (exact) return { feedingRate: exact.feedingRatePercent, fcr: exact.fcr };

  // İnterpolasyon
  const lower = sorted.filter(p => p.fishWeightG < weightG).pop();
  const upper = sorted.find(p => p.fishWeightG > weightG);

  if (!lower && upper) return { feedingRate: upper.feedingRatePercent, fcr: upper.fcr };
  if (lower && !upper) return { feedingRate: lower.feedingRatePercent, fcr: lower.fcr };
  if (!lower || !upper) return null;

  // Linear interpolation
  const ratio = (weightG - lower.fishWeightG) / (upper.fishWeightG - lower.fishWeightG);
  return {
    feedingRate: lower.feedingRatePercent + ratio * (upper.feedingRatePercent - lower.feedingRatePercent),
    fcr: lower.fcr + ratio * (upper.fcr - lower.fcr)
  };
}
