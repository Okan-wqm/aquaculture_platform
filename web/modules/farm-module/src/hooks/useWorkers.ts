/**
 * Workers hooks for farm-module
 * Handles CRUD operations for workers (employees) via GraphQL API
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';

export interface Worker {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  department: string;
  position: string;
  isVeterinarian: boolean;
  veterinaryLicenseNumber?: string;
  status: string;
  hireDate: string;
  createdAt: string;
}

export interface CreateWorkerInput {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  position: string;
  isVeterinarian?: boolean;
  veterinaryLicenseNumber?: string;
}

export interface UpdateWorkerInput {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  position?: string;
  isVeterinarian?: boolean;
  veterinaryLicenseNumber?: string;
}

const WORKERS_LIST_QUERY = `
  query Workers {
    workers {
      id
      employeeNumber
      firstName
      lastName
      email
      phone
      department
      position
      isVeterinarian
      veterinaryLicenseNumber
      status
      hireDate
      createdAt
    }
  }
`;

const CREATE_WORKER_MUTATION = `
  mutation CreateWorker($input: CreateWorkerInput!) {
    createWorker(input: $input) {
      id
      employeeNumber
      firstName
      lastName
      email
      phone
      department
      position
      isVeterinarian
      veterinaryLicenseNumber
      status
      hireDate
      createdAt
    }
  }
`;

const UPDATE_WORKER_MUTATION = `
  mutation UpdateWorker($input: UpdateWorkerInput!) {
    updateWorker(input: $input) {
      id
      employeeNumber
      firstName
      lastName
      email
      phone
      department
      position
      isVeterinarian
      veterinaryLicenseNumber
      status
      hireDate
      createdAt
    }
  }
`;

const DELETE_WORKER_MUTATION = `
  mutation DeleteWorker($id: ID!) {
    deleteWorker(id: $id)
  }
`;

export function useWorkerList() {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'workers', 'list'),
    queryFn: async () => {
      const data = await graphqlClient.request<{ workers: Worker[] }>(
        WORKERS_LIST_QUERY,
      );
      return data.workers;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId,
  });
}

export function useCreateWorker() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateWorkerInput) => {
      if (!token) throw new Error('Authentication required. Please login first.');
      if (!tenantId) throw new Error('Tenant context required. Please re-login.');
      const data = await graphqlClient.request<{ createWorker: Worker }>(
        CREATE_WORKER_MUTATION,
        { input },
      );
      return data.createWorker;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workers', 'list') });
    },
  });
}

export function useUpdateWorker() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateWorkerInput) => {
      if (!token) throw new Error('Authentication required. Please login first.');
      if (!tenantId) throw new Error('Tenant context required. Please re-login.');
      const data = await graphqlClient.request<{ updateWorker: Worker }>(
        UPDATE_WORKER_MUTATION,
        { input },
      );
      return data.updateWorker;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workers', 'list') });
    },
  });
}

export function useDeleteWorker() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!token) throw new Error('Authentication required. Please login first.');
      if (!tenantId) throw new Error('Tenant context required. Please re-login.');
      const data = await graphqlClient.request<{ deleteWorker: boolean }>(
        DELETE_WORKER_MUTATION,
        { id },
      );
      return data.deleteWorker;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workers', 'list') });
    },
  });
}
