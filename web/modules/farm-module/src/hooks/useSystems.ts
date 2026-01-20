/**
 * Systems hooks for farm-module
 * Handles CRUD operations for systems via GraphQL API
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient } from '@aquaculture/shared-ui';

// Types
export interface System {
  id: string;
  name: string;
  code: string;
  type: string;
  status: string;
  siteId: string;
  site?: {
    id: string;
    name: string;
  };
  departmentId?: string;
  department?: {
    id: string;
    name: string;
  };
  parentSystemId?: string;
  parentSystem?: System;
  childSystems?: System[];
  description?: string;
  totalVolumeM3?: number;
  maxBiomassKg?: number;
  tankCount?: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSystemInput {
  name: string;
  code: string;
  type: string;
  siteId: string;
  departmentId?: string;
  parentSystemId?: string;
  status?: string;
  description?: string;
  totalVolumeM3?: number;
  maxBiomassKg?: number;
  tankCount?: number;
}

export interface UpdateSystemInput extends Partial<CreateSystemInput> {
  id: string;
  isActive?: boolean;
}

interface PaginatedResponse {
  items: System[];
  total: number;
  page: number;
  limit: number;
}

// GraphQL queries
const SYSTEMS_LIST_QUERY = `
  query Systems($filter: SystemFilterInput, $pagination: PaginationInput) {
    systems(filter: $filter, pagination: $pagination) {
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
        departmentId
        department {
          id
          name
        }
        parentSystemId
        parentSystem {
          id
          name
        }
        description
        totalVolumeM3
        maxBiomassKg
        tankCount
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

const SYSTEMS_BY_SITE_QUERY = `
  query SystemsBySite($siteId: ID!) {
    systemsBySite(siteId: $siteId) {
      id
      name
      code
      type
      status
      siteId
      departmentId
      parentSystemId
      description
      isActive
    }
  }
`;

const SYSTEMS_BY_DEPARTMENT_QUERY = `
  query SystemsByDepartment($departmentId: ID!) {
    systemsByDepartment(departmentId: $departmentId) {
      id
      name
      code
      type
      status
      siteId
      departmentId
      parentSystemId
      description
      isActive
    }
  }
`;

const ROOT_SYSTEMS_QUERY = `
  query RootSystems($siteId: ID) {
    rootSystems(siteId: $siteId) {
      id
      name
      code
      type
      status
      siteId
      departmentId
      description
      isActive
    }
  }
`;

const CHILD_SYSTEMS_QUERY = `
  query ChildSystems($parentSystemId: ID!) {
    childSystems(parentSystemId: $parentSystemId) {
      id
      name
      code
      type
      status
      siteId
      departmentId
      parentSystemId
      description
      isActive
    }
  }
`;

const SYSTEM_QUERY = `
  query System($id: ID!, $includeRelations: Boolean) {
    system(id: $id, includeRelations: $includeRelations) {
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
      departmentId
      department {
        id
        name
      }
      parentSystemId
      parentSystem {
        id
        name
      }
      description
      totalVolumeM3
      maxBiomassKg
      tankCount
      isActive
    }
  }
`;

const CREATE_SYSTEM_MUTATION = `
  mutation CreateSystem($input: CreateSystemInput!) {
    createSystem(input: $input) {
      id
      name
      code
      type
      status
      siteId
      departmentId
      parentSystemId
      isActive
    }
  }
`;

const UPDATE_SYSTEM_MUTATION = `
  mutation UpdateSystem($input: UpdateSystemInput!) {
    updateSystem(input: $input) {
      id
      name
      code
      type
      status
      siteId
      departmentId
      parentSystemId
      isActive
    }
  }
`;

const DELETE_SYSTEM_MUTATION = `
  mutation DeleteSystem($id: ID!, $cascade: Boolean!) {
    deleteSystem(id: $id, cascade: $cascade)
  }
`;

const SYSTEM_DELETE_PREVIEW_QUERY = `
  query SystemDeletePreview($id: ID!) {
    systemDeletePreview(id: $id) {
      system {
        id
        name
        code
      }
      canDelete
      blockers
      affectedItems {
        childSystems {
          id
          name
          code
          equipmentCount
        }
        equipment {
          id
          name
          code
          status
        }
        totalCount
      }
    }
  }
`;

// graphqlClient from shared-ui handles token/tenantId automatically

/**
 * Hook to fetch systems list
 */
export function useSystemList(filter?: {
  siteId?: string;
  departmentId?: string;
  parentSystemId?: string;
  type?: string;
  status?: string;
  isActive?: boolean;
  rootOnly?: boolean;
  search?: string;
}) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['systems', 'list', filter],
    queryFn: async () => {
      const data = await graphqlClient.request<{ systems: PaginatedResponse }>(
        SYSTEMS_LIST_QUERY,
        { filter }
      );
      return data.systems;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId,
  });
}

/**
 * Hook to fetch systems by site
 */
export function useSystemsBySite(siteId: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['systems', 'bySite', siteId],
    queryFn: async () => {
      const data = await graphqlClient.request<{ systemsBySite: System[] }>(
        SYSTEMS_BY_SITE_QUERY,
        { siteId }
      );
      return data.systemsBySite;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!siteId,
  });
}

/**
 * Hook to fetch systems by department
 */
export function useSystemsByDepartment(departmentId: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['systems', 'byDepartment', departmentId],
    queryFn: async () => {
      const data = await graphqlClient.request<{ systemsByDepartment: System[] }>(
        SYSTEMS_BY_DEPARTMENT_QUERY,
        { departmentId }
      );
      return data.systemsByDepartment;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!departmentId,
  });
}

/**
 * Hook to fetch root systems (no parent)
 */
export function useRootSystems(siteId?: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['systems', 'root', siteId],
    queryFn: async () => {
      const data = await graphqlClient.request<{ rootSystems: System[] }>(
        ROOT_SYSTEMS_QUERY,
        { siteId }
      );
      return data.rootSystems;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId,
  });
}

/**
 * Hook to fetch child systems of a parent
 */
export function useChildSystems(parentSystemId: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['systems', 'children', parentSystemId],
    queryFn: async () => {
      const data = await graphqlClient.request<{ childSystems: System[] }>(
        CHILD_SYSTEMS_QUERY,
        { parentSystemId }
      );
      return data.childSystems;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!parentSystemId,
  });
}

/**
 * Hook to fetch single system
 */
export function useSystem(id: string, includeRelations: boolean = false) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['systems', 'detail', id, includeRelations],
    queryFn: async () => {
      const data = await graphqlClient.request<{ system: System }>(
        SYSTEM_QUERY,
        { id, includeRelations }
      );
      return data.system;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!id,
  });
}

/**
 * Hook to create system
 */
export function useCreateSystem() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateSystemInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ createSystem: System }>(
        CREATE_SYSTEM_MUTATION,
        { input }
      );
      return data.createSystem;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['systems', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['systems', 'bySite'] });
      queryClient.invalidateQueries({ queryKey: ['systems', 'byDepartment'] });
      queryClient.invalidateQueries({ queryKey: ['systems', 'root'] });
      queryClient.invalidateQueries({ queryKey: ['systems', 'children'] });
    },
  });
}

/**
 * Hook to update system
 */
export function useUpdateSystem() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateSystemInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ updateSystem: System }>(
        UPDATE_SYSTEM_MUTATION,
        { input }
      );
      return data.updateSystem;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['systems', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['systems', 'bySite'] });
      queryClient.invalidateQueries({ queryKey: ['systems', 'byDepartment'] });
      queryClient.invalidateQueries({ queryKey: ['systems', 'root'] });
      queryClient.invalidateQueries({ queryKey: ['systems', 'children'] });
      queryClient.invalidateQueries({ queryKey: ['systems', 'detail', variables.id] });
    },
  });
}

// Delete Preview Types
export interface SystemDeletePreviewResult {
  system: { id: string; name: string; code: string };
  canDelete: boolean;
  blockers: string[];
  affectedItems: {
    childSystems: Array<{ id: string; name: string; code: string; equipmentCount: number }>;
    equipment: Array<{ id: string; name: string; code: string; status: string }>;
    totalCount: number;
  };
}

/**
 * Hook to get system delete preview
 */
export function useSystemDeletePreview(id: string | null) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['systems', 'deletePreview', id],
    queryFn: async () => {
      const data = await graphqlClient.request<{ systemDeletePreview: SystemDeletePreviewResult }>(
        SYSTEM_DELETE_PREVIEW_QUERY,
        { id }
      );
      return data.systemDeletePreview;
    },
    staleTime: 0, // Always fetch fresh data for delete preview
    enabled: !!token && !!tenantId && !!id,
  });
}

/**
 * Hook to delete system
 * @param cascade - If true, cascade delete all related items
 */
export function useDeleteSystem() {
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
      const data = await graphqlClient.request<{ deleteSystem: boolean }>(
        DELETE_SYSTEM_MUTATION,
        { id, cascade }
      );
      return data.deleteSystem;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['systems', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['systems', 'bySite'] });
      queryClient.invalidateQueries({ queryKey: ['systems', 'byDepartment'] });
      queryClient.invalidateQueries({ queryKey: ['systems', 'root'] });
      queryClient.invalidateQueries({ queryKey: ['systems', 'children'] });
      queryClient.invalidateQueries({ queryKey: ['equipment', 'list'] });
    },
  });
}
