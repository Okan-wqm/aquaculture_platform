/**
 * Departments hooks for farm-module
 * Handles CRUD operations for departments via GraphQL API
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient } from '@aquaculture/shared-ui';

// Types
export interface Department {
  id: string;
  name: string;
  code: string;
  type: string;
  status: string;
  siteId?: string;  // nullable - orphaned departments when site is deleted
  site?: {
    id: string;
    name: string;
  } | null;  // can be null for orphaned departments
  description?: string;
  capacity?: number;
  currentLoad?: number;
  departmentManager?: string;
  contactEmail?: string;
  contactPhone?: string;
  notes?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDepartmentInput {
  name: string;
  code: string;
  type: string;
  siteId: string;
  status?: string;
  description?: string;
  capacity?: number;
  departmentManager?: string;
  contactEmail?: string;
  contactPhone?: string;
  notes?: string;
}

export interface UpdateDepartmentInput extends Partial<CreateDepartmentInput> {
  id: string;
  isActive?: boolean;
}

interface PaginatedResponse {
  items: Department[];
  total: number;
  page: number;
  limit: number;
}

// GraphQL queries
const DEPARTMENTS_LIST_QUERY = `
  query Departments($filter: DepartmentFilterInput, $pagination: PaginationInput) {
    departments(filter: $filter, pagination: $pagination) {
      items {
        id
        name
        code
        type
        status
        siteId
        site {
          id
          name
        }
        description
        capacity
        currentLoad
        departmentManager
        contactEmail
        contactPhone
        isActive
        createdAt
        updatedAt
      }
      total
      page
      limit
    }
  }
`;

const DEPARTMENTS_BY_SITE_QUERY = `
  query DepartmentsBySite($siteId: ID!) {
    departmentsBySite(siteId: $siteId) {
      id
      name
      code
      type
      status
      siteId
      description
      isActive
    }
  }
`;

const DEPARTMENT_QUERY = `
  query Department($id: ID!) {
    department(id: $id) {
      id
      name
      code
      type
      status
      siteId
      site {
        id
        name
      }
      description
      capacity
      currentLoad
      departmentManager
      contactEmail
      contactPhone
      isActive
      createdAt
      updatedAt
    }
  }
`;

const CREATE_DEPARTMENT_MUTATION = `
  mutation CreateDepartment($input: CreateDepartmentInput!) {
    createDepartment(input: $input) {
      id
      name
      code
      type
      status
      siteId
      isActive
    }
  }
`;

const UPDATE_DEPARTMENT_MUTATION = `
  mutation UpdateDepartment($input: UpdateDepartmentInput!) {
    updateDepartment(input: $input) {
      id
      name
      code
      type
      status
      siteId
      isActive
    }
  }
`;

const DELETE_DEPARTMENT_MUTATION = `
  mutation DeleteDepartment($id: ID!, $cascade: Boolean!) {
    deleteDepartment(id: $id, cascade: $cascade)
  }
`;

const DEPARTMENT_DELETE_PREVIEW_QUERY = `
  query DepartmentDeletePreview($id: ID!) {
    departmentDeletePreview(id: $id) {
      department {
        id
        name
        code
      }
      canDelete
      blockers
      affectedItems {
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

// graphqlClient from shared-ui handles token/tenantId automatically

/**
 * Hook to fetch departments list
 */
export function useDepartmentList(filter?: {
  siteId?: string;
  type?: string;
  isActive?: boolean;
  search?: string;
}) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['departments', 'list', filter],
    queryFn: async () => {
      const data = await graphqlClient.request<{ departments: PaginatedResponse }>(
        DEPARTMENTS_LIST_QUERY,
        { filter }
      );
      return data.departments;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId,
  });
}

/**
 * Hook to fetch departments by site
 */
export function useDepartmentsBySite(siteId: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['departments', 'bySite', siteId],
    queryFn: async () => {
      const data = await graphqlClient.request<{ departmentsBySite: Department[] }>(
        DEPARTMENTS_BY_SITE_QUERY,
        { siteId }
      );
      return data.departmentsBySite;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!siteId,
  });
}

/**
 * Hook to fetch single department
 */
export function useDepartment(id: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['departments', 'detail', id],
    queryFn: async () => {
      const data = await graphqlClient.request<{ department: Department }>(
        DEPARTMENT_QUERY,
        { id }
      );
      return data.department;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!id,
  });
}

/**
 * Hook to create department
 */
export function useCreateDepartment() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateDepartmentInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ createDepartment: Department }>(
        CREATE_DEPARTMENT_MUTATION,
        { input }
      );
      return data.createDepartment;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['departments', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['departments', 'bySite'] });
    },
  });
}

/**
 * Hook to update department
 */
export function useUpdateDepartment() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateDepartmentInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ updateDepartment: Department }>(
        UPDATE_DEPARTMENT_MUTATION,
        { input }
      );
      return data.updateDepartment;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['departments', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['departments', 'bySite'] });
      queryClient.invalidateQueries({ queryKey: ['departments', 'detail', variables.id] });
    },
  });
}

// Delete Preview Types
export interface DepartmentDeletePreviewResult {
  department: { id: string; name: string; code: string };
  canDelete: boolean;
  blockers: string[];
  affectedItems: {
    equipment: Array<{ id: string; name: string; code: string; status: string }>;
    tanks: Array<{ id: string; name: string; code: string; currentBiomass: number; hasActiveBiomass: boolean }>;
    totalCount: number;
  };
}

/**
 * Hook to get department delete preview
 */
export function useDepartmentDeletePreview(id: string | null) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['departments', 'deletePreview', id],
    queryFn: async () => {
      const data = await graphqlClient.request<{ departmentDeletePreview: DepartmentDeletePreviewResult }>(
        DEPARTMENT_DELETE_PREVIEW_QUERY,
        { id }
      );
      return data.departmentDeletePreview;
    },
    staleTime: 0, // Always fetch fresh data for delete preview
    enabled: !!token && !!tenantId && !!id,
  });
}

/**
 * Hook to delete department
 * @param cascade - If true, cascade delete all related items
 */
export function useDeleteDepartment() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, cascade = false }: { id: string; cascade?: boolean }) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ deleteDepartment: boolean }>(
        DELETE_DEPARTMENT_MUTATION,
        { id, cascade }
      );
      return data.deleteDepartment;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['departments', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['departments', 'bySite'] });
      queryClient.invalidateQueries({ queryKey: ['equipment', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['systems', 'list'] });  // Systems may become orphaned
    },
  });
}
