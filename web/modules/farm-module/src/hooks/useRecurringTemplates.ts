/**
 * Recurring Template hooks for farm-module
 * Handles CRUD operations for recurring task templates via GraphQL API
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { graphqlClient, useAuth, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';
import { RecurringTemplate } from '../pages/tasks/types/task.types';

// ============================================================================
// GRAPHQL FIELD FRAGMENTS
// ============================================================================

const RECURRING_TEMPLATE_FIELDS = `
  id
  title
  description
  category
  priority
  frequency
  frequencyDetail
  assignedTo
  assignedToName
  location
  estimatedMinutes
  checklistItems {
    id
    text
    isCompleted
    completedAt
    completedBy
  }
  isActive
  lastGenerated
  nextGeneration
  tags
`;

// ============================================================================
// INPUT TYPES
// ============================================================================

export interface CreateRecurringTemplateInput {
  title: string;
  description?: string;
  category: string;
  priority: string;
  frequency: string;
  frequencyDetail?: string;
  assignedTo?: string;
  assignedToName?: string;
  location?: string;
  estimatedMinutes?: number;
  checklistItems?: { text: string; isCompleted?: boolean }[];
  tags?: string[];
}

export interface UpdateRecurringTemplateInput {
  id: string;
  title?: string;
  description?: string;
  category?: string;
  priority?: string;
  frequency?: string;
  frequencyDetail?: string;
  assignedTo?: string;
  assignedToName?: string;
  location?: string;
  estimatedMinutes?: number;
  checklistItems?: { text: string; isCompleted?: boolean }[];
  isActive?: boolean;
  tags?: string[];
}

// ============================================================================
// HOOKS
// ============================================================================

/**
 * Hook to fetch and manage recurring templates
 * @param enabled - false ise sorgu çalışmaz (lazy loading)
 */
export function useRecurringTemplates(enabled = true) {
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  // Templates query
  const templatesQuery = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'recurringTemplates'),
    enabled: enabled && !!tenantId,
    staleTime: 60_000, // 1 dakika
    queryFn: async () => {
      const query = `
        query RecurringTemplates {
          recurringTemplates {
            ${RECURRING_TEMPLATE_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{
        recurringTemplates: RecurringTemplate[];
      }>(query);

      return result.recurringTemplates;
    },
  });

  // --- Mutations ---

  const createTemplateMutation = useMutation({
    mutationFn: async (input: CreateRecurringTemplateInput) => {
      const mutation = `
        mutation CreateRecurringTemplate($input: CreateRecurringTemplateInput!) {
          createRecurringTemplate(input: $input) {
            ${RECURRING_TEMPLATE_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ createRecurringTemplate: RecurringTemplate }>(
        mutation,
        { input }
      );

      return result.createRecurringTemplate;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'recurringTemplates') });
    },
    onError: (error: Error) => {
      console.error('Mutation failed:', error.message);
    },
  });

  const updateTemplateMutation = useMutation({
    mutationFn: async (input: UpdateRecurringTemplateInput) => {
      const mutation = `
        mutation UpdateRecurringTemplate($input: UpdateRecurringTemplateInput!) {
          updateRecurringTemplate(input: $input) {
            ${RECURRING_TEMPLATE_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ updateRecurringTemplate: RecurringTemplate }>(
        mutation,
        { input }
      );

      return result.updateRecurringTemplate;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'recurringTemplates') });
    },
    onError: (error: Error) => {
      console.error('Mutation failed:', error.message);
    },
  });

  const deleteTemplateMutation = useMutation({
    mutationFn: async (id: string) => {
      const mutation = `
        mutation DeleteRecurringTemplate($id: String!) {
          deleteRecurringTemplate(id: $id)
        }
      `;

      const result = await graphqlClient.request<{ deleteRecurringTemplate: boolean }>(
        mutation,
        { id }
      );

      return result.deleteRecurringTemplate;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'recurringTemplates') });
    },
    onError: (error: Error) => {
      console.error('Mutation failed:', error.message);
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async (id: string) => {
      const mutation = `
        mutation ToggleRecurringTemplateActive($id: String!) {
          toggleRecurringTemplateActive(id: $id) {
            ${RECURRING_TEMPLATE_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ toggleRecurringTemplateActive: RecurringTemplate }>(
        mutation,
        { id }
      );

      return result.toggleRecurringTemplateActive;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'recurringTemplates') });
    },
    onError: (error: Error) => {
      console.error('Mutation failed:', error.message);
    },
  });

  return {
    // Data
    templates: templatesQuery.data ?? [],
    // Loading / error
    loading: templatesQuery.isLoading,
    error: templatesQuery.error,
    // Mutations
    createTemplate: createTemplateMutation.mutateAsync,
    updateTemplate: updateTemplateMutation.mutateAsync,
    deleteTemplate: deleteTemplateMutation.mutateAsync,
    toggleActive: toggleActiveMutation.mutateAsync,
    // Mutation loading states
    creating: createTemplateMutation.isPending,
    updating: updateTemplateMutation.isPending,
    deleting: deleteTemplateMutation.isPending,
    // Mutation errors
    createError: createTemplateMutation.error,
    updateError: updateTemplateMutation.error,
    deleteError: deleteTemplateMutation.error,
    // Refetch
    refetch: templatesQuery.refetch,
  };
}
