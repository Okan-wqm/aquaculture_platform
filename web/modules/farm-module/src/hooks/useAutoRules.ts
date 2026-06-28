/**
 * Auto Rules hooks for farm-module
 * Handles CRUD operations for auto rules via GraphQL API
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { graphqlClient, useAuth, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';
import { AutoRule } from '../pages/tasks/types/task.types';

// ============================================================================
// GRAPHQL FIELD FRAGMENTS
// ============================================================================

const AUTO_RULE_FIELDS = `
  id
  name
  description
  trigger
  triggerCondition
  taskTitle
  taskDescription
  taskCategory
  taskPriority
  assignTo
  isActive
  lastTriggered
  triggerCount
`;

// ============================================================================
// INPUT TYPES
// ============================================================================

export interface CreateAutoRuleInput {
  name: string;
  description?: string;
  trigger: string;
  triggerCondition: string;
  taskTitle: string;
  taskDescription?: string;
  taskCategory: string;
  taskPriority: string;
  assignTo?: string;
}

export interface UpdateAutoRuleInput {
  id: string;
  name?: string;
  description?: string;
  trigger?: string;
  triggerCondition?: string;
  taskTitle?: string;
  taskDescription?: string;
  taskCategory?: string;
  taskPriority?: string;
  assignTo?: string;
}

// ============================================================================
// HOOKS
// ============================================================================

/**
 * Hook to fetch and manage auto rules
 * @param enabled - false ise sorgu çalışmaz (lazy loading)
 */
export function useAutoRules(enabled = true) {
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  // Auto rules query
  const autoRulesQuery = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'autoRules'),
    enabled: enabled && !!tenantId,
    staleTime: 60_000, // 1 dakika
    queryFn: async () => {
      const query = `
        query AutoRules {
          autoRules {
            ${AUTO_RULE_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{
        autoRules: AutoRule[];
      }>(query);

      return result.autoRules;
    },
  });

  // --- Mutations ---

  const createRuleMutation = useMutation({
    mutationFn: async (input: CreateAutoRuleInput) => {
      const mutation = `
        mutation CreateAutoRule($input: CreateAutoRuleInput!) {
          createAutoRule(input: $input) {
            ${AUTO_RULE_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ createAutoRule: AutoRule }>(
        mutation,
        { input }
      );

      return result.createAutoRule;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'autoRules') });
    },
    onError: (error: Error) => {
      console.error('CreateAutoRule failed:', error.message);
    },
  });

  const updateRuleMutation = useMutation({
    mutationFn: async (input: UpdateAutoRuleInput) => {
      const mutation = `
        mutation UpdateAutoRule($input: UpdateAutoRuleInput!) {
          updateAutoRule(input: $input) {
            ${AUTO_RULE_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ updateAutoRule: AutoRule }>(
        mutation,
        { input }
      );

      return result.updateAutoRule;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'autoRules') });
    },
    onError: (error: Error) => {
      console.error('UpdateAutoRule failed:', error.message);
    },
  });

  const deleteRuleMutation = useMutation({
    mutationFn: async (id: string) => {
      const mutation = `
        mutation DeleteAutoRule($id: ID!) {
          deleteAutoRule(id: $id)
        }
      `;

      const result = await graphqlClient.request<{ deleteAutoRule: boolean }>(
        mutation,
        { id }
      );

      return result.deleteAutoRule;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'autoRules') });
    },
    onError: (error: Error) => {
      console.error('DeleteAutoRule failed:', error.message);
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async (id: string) => {
      const mutation = `
        mutation ToggleAutoRuleActive($id: ID!) {
          toggleAutoRuleActive(id: $id) {
            ${AUTO_RULE_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ toggleAutoRuleActive: AutoRule }>(
        mutation,
        { id }
      );

      return result.toggleAutoRuleActive;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'autoRules') });
    },
    onError: (error: Error) => {
      console.error('ToggleAutoRuleActive failed:', error.message);
    },
  });

  return {
    // Data
    autoRules: autoRulesQuery.data ?? [],
    // Loading / error
    loading: autoRulesQuery.isLoading,
    error: autoRulesQuery.error,
    // Mutations
    createRule: createRuleMutation.mutateAsync,
    updateRule: updateRuleMutation.mutateAsync,
    deleteRule: deleteRuleMutation.mutateAsync,
    toggleActive: toggleActiveMutation.mutateAsync,
    // Mutation loading states
    creating: createRuleMutation.isPending,
    updating: updateRuleMutation.isPending,
    deleting: deleteRuleMutation.isPending,
    // Error states
    createError: createRuleMutation.error,
    updateError: updateRuleMutation.error,
    deleteError: deleteRuleMutation.error,
    // Refetch
    refetch: autoRulesQuery.refetch,
  };
}
