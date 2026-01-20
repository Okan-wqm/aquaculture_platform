/**
 * Suppliers hooks for farm-module
 * Handles CRUD operations for suppliers via GraphQL API
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient } from '@aquaculture/shared-ui';

// Enums - Values must be UPPERCASE to match GraphQL enum keys
export enum SupplierType {
  FRY = 'FRY',
  FEED = 'FEED',
  EQUIPMENT = 'EQUIPMENT',
  CHEMICAL = 'CHEMICAL',
  SERVICE = 'SERVICE',
  OTHER = 'OTHER',
}

export enum SupplierStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  SUSPENDED = 'SUSPENDED',
  BLACKLISTED = 'BLACKLISTED',
}

// Types
export interface SupplierTypeResponse {
  id: string;
  name: string;
  code: string;
  description?: string;
  icon?: string;
  isActive: boolean;
  sortOrder: number;
}

export interface SupplierAddress {
  street?: string;
  city: string;
  state?: string;
  postalCode?: string;
  country: string;
}

export interface SupplierContact {
  name: string;
  title?: string;
  email?: string;
  phone?: string;
  department?: string;
  isPrimary?: boolean;
}

export interface PaymentTerms {
  paymentDays: number;
  creditLimit?: number;
  currency: string;
  discountPercent?: number;
  discountDays?: number;
  notes?: string;
}

export interface Supplier {
  id: string;
  tenantId: string;
  name: string;
  code: string;
  type: SupplierType;
  description?: string;
  categories?: string[];
  products?: string[];
  status: SupplierStatus;
  contactPerson?: string;
  primaryContact?: SupplierContact;
  contacts?: SupplierContact[];
  email?: string;
  phone?: string;
  fax?: string;
  website?: string;
  address?: SupplierAddress;
  city?: string;
  country?: string;
  taxNumber?: string;
  paymentTerms?: PaymentTerms | null;
  rating?: number;
  certifications?: string[];
  notes?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
}

export interface CreateSupplierInput {
  name: string;
  code?: string;
  type: SupplierType;
  description?: string;
  categories?: string[];
  products?: string[];
  // Note: status is not accepted during create - new suppliers default to ACTIVE
  contactPerson?: string;
  primaryContact?: SupplierContact;
  email?: string;
  phone?: string;
  fax?: string;
  website?: string;
  address?: SupplierAddress;
  city?: string;
  country?: string;
  taxNumber?: string;
  paymentTerms?: PaymentTerms;
  rating?: number;
  certifications?: string[];
  notes?: string;
}

export interface UpdateSupplierInput extends Partial<CreateSupplierInput> {
  id: string;
  status?: SupplierStatus;  // Status can be changed during update
  isActive?: boolean;
}

interface PaginatedResponse {
  items: Supplier[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// GraphQL queries
const SUPPLIERS_LIST_QUERY = `
  query Suppliers($filter: SupplierFilterInput, $pagination: PaginationInput) {
    suppliers(filter: $filter, pagination: $pagination) {
      items {
        id
        tenantId
        name
        code
        type
        description
        categories
        products
        status
        contactPerson
        primaryContact {
          name
          title
          email
          phone
        }
        email
        phone
        fax
        website
        address {
          street
          city
          state
          postalCode
          country
        }
        city
        country
        taxNumber
        paymentTerms {
          paymentDays
          creditLimit
          currency
        }
        rating
        certifications
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

const SUPPLIER_QUERY = `
  query Supplier($id: ID!) {
    supplier(id: $id) {
      id
      tenantId
      name
      code
      type
      description
      categories
      products
      status
      contactPerson
      primaryContact {
        name
        title
        email
        phone
      }
      email
      phone
      fax
      website
      address {
        street
        city
        state
        postalCode
        country
      }
      city
      country
      taxNumber
      paymentTerms {
        paymentDays
        creditLimit
        currency
      }
      rating
      certifications
      notes
      isActive
      createdAt
      updatedAt
    }
  }
`;

const CREATE_SUPPLIER_MUTATION = `
  mutation CreateSupplier($input: CreateSupplierInput!) {
    createSupplier(input: $input) {
      id
      name
      code
      type
      status
      isActive
    }
  }
`;

const UPDATE_SUPPLIER_MUTATION = `
  mutation UpdateSupplier($input: UpdateSupplierInput!) {
    updateSupplier(input: $input) {
      id
      name
      code
      type
      status
      isActive
    }
  }
`;

const DELETE_SUPPLIER_MUTATION = `
  mutation DeleteSupplier($id: ID!) {
    deleteSupplier(id: $id)
  }
`;

const SUPPLIER_TYPES_QUERY = `
  query SupplierTypes {
    supplierTypes {
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

// graphqlClient from shared-ui handles token/tenantId automatically

/**
 * Hook to fetch suppliers list
 */
export function useSupplierList(filter?: {
  type?: SupplierType;
  status?: SupplierStatus;
  isActive?: boolean;
  country?: string;
  search?: string;
}) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['suppliers', 'list', filter],
    queryFn: async () => {
      const data = await graphqlClient.request<{ suppliers: PaginatedResponse }>(
        SUPPLIERS_LIST_QUERY,
        { filter }
      );
      return data.suppliers;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId,
  });
}

/**
 * Hook to fetch single supplier
 */
export function useSupplier(id: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['suppliers', 'detail', id],
    queryFn: async () => {
      const data = await graphqlClient.request<{ supplier: Supplier }>(
        SUPPLIER_QUERY,
        { id }
      );
      return data.supplier;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!id,
  });
}

/**
 * Hook to create supplier
 */
export function useCreateSupplier() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateSupplierInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ createSupplier: Supplier }>(
        CREATE_SUPPLIER_MUTATION,
        { input }
      );
      return data.createSupplier;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suppliers', 'list'] });
    },
  });
}

/**
 * Hook to update supplier
 */
export function useUpdateSupplier() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateSupplierInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ updateSupplier: Supplier }>(
        UPDATE_SUPPLIER_MUTATION,
        { input }
      );
      return data.updateSupplier;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['suppliers', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['suppliers', 'detail', variables.id] });
    },
  });
}

/**
 * Hook to delete supplier
 */
export function useDeleteSupplier() {
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
      const data = await graphqlClient.request<{ deleteSupplier: boolean }>(
        DELETE_SUPPLIER_MUTATION,
        { id }
      );
      return data.deleteSupplier;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suppliers', 'list'] });
    },
  });
}

/**
 * Hook to fetch supplier types (global, not tenant-specific)
 */
export function useSupplierTypes() {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['suppliers', 'types'],
    queryFn: async () => {
      const data = await graphqlClient.request<{ supplierTypes: SupplierTypeResponse[] }>(
        SUPPLIER_TYPES_QUERY,
        {}
      );
      return data.supplierTypes;
    },
    staleTime: 60000, // Types don't change often
    enabled: !!token,
  });
}
