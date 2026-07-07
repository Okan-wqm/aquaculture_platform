/**
 * Slaughter-facility catalog hooks for farm-module.
 *
 * The catalog is the SSoT for the slakt reports' godkjenningsnummer (approval
 * number): the default facility feeds the server-side slakt assembler. Each
 * tenant may slaughter through several facilities and marks one default.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useAuth,
  graphqlClient,
  useTenantQuery,
  createTenantInvalidationKey,
} from '@aquaculture/shared-ui';

export interface SlaughterFacility {
  id: string;
  tenantId: string;
  name: string;
  godkjenningsnummer: string;
  isDefault: boolean;
  address?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSlaughterFacilityInput {
  name: string;
  godkjenningsnummer: string;
  isDefault?: boolean;
  address?: string;
}

export interface UpdateSlaughterFacilityInput {
  id: string;
  name?: string;
  godkjenningsnummer?: string;
  isDefault?: boolean;
  address?: string;
  isActive?: boolean;
}

const FACILITY_FIELDS = `
  id
  tenantId
  name
  godkjenningsnummer
  isDefault
  address
  isActive
  createdAt
  updatedAt
`;

const SLAUGHTER_FACILITIES_QUERY = `
  query SlaughterFacilities($includeInactive: Boolean) {
    slaughterFacilities(includeInactive: $includeInactive) {
      ${FACILITY_FIELDS}
    }
  }
`;

const CREATE_SLAUGHTER_FACILITY_MUTATION = `
  mutation CreateSlaughterFacility($input: CreateSlaughterFacilityInput!) {
    createSlaughterFacility(input: $input) {
      ${FACILITY_FIELDS}
    }
  }
`;

const UPDATE_SLAUGHTER_FACILITY_MUTATION = `
  mutation UpdateSlaughterFacility($input: UpdateSlaughterFacilityInput!) {
    updateSlaughterFacility(input: $input) {
      ${FACILITY_FIELDS}
    }
  }
`;

/**
 * Fetch the slaughter-facility catalog (active first, default first).
 */
export function useSlaughterFacilities(includeInactive = false) {
  return useTenantQuery<SlaughterFacility[]>(
    ['slaughterFacilities', 'list', { includeInactive }],
    async () => {
      const data = await graphqlClient.request<{ slaughterFacilities: SlaughterFacility[] }>(
        SLAUGHTER_FACILITIES_QUERY,
        { includeInactive },
      );
      return data.slaughterFacilities;
    },
    { staleTime: 30000 },
  );
}

export function useCreateSlaughterFacility() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateSlaughterFacilityInput) => {
      if (!token) throw new Error('Authentication required. Please login first.');
      if (!tenantId) throw new Error('Tenant context required. Please re-login.');
      const data = await graphqlClient.request<{ createSlaughterFacility: SlaughterFacility }>(
        CREATE_SLAUGHTER_FACILITY_MUTATION,
        { input },
      );
      return data.createSlaughterFacility;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, 'slaughterFacilities', 'list'),
      });
    },
  });
}

export function useUpdateSlaughterFacility() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateSlaughterFacilityInput) => {
      if (!token) throw new Error('Authentication required. Please login first.');
      if (!tenantId) throw new Error('Tenant context required. Please re-login.');
      const data = await graphqlClient.request<{ updateSlaughterFacility: SlaughterFacility }>(
        UPDATE_SLAUGHTER_FACILITY_MUTATION,
        { input },
      );
      return data.updateSlaughterFacility;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, 'slaughterFacilities', 'list'),
      });
    },
  });
}
