/**
 * React Query hooks for Alert Rule CRUD operations
 *
 * Uses the alert-engine GraphQL API:
 * - alertRule(id) query
 * - alertRules(farmId, pondId, isActive) query
 * - createAlertRule mutation
 * - updateAlertRule mutation
 * - deleteAlertRule mutation
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';
import { graphqlFetch } from '../config/api';
import {
  ALERT_RULE_QUERY,
  ALERT_RULES_QUERY,
  CREATE_ALERT_RULE_MUTATION,
  UPDATE_ALERT_RULE_MUTATION,
  DELETE_ALERT_RULE_MUTATION,
} from '../graphql/alertRule.operations';

// ============================================================================
// Types
// ============================================================================

export type AlertOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
export type AlertSeverity = 'info' | 'low' | 'warning' | 'medium' | 'high' | 'critical';

export interface AlertCondition {
  parameter: string;
  operator: AlertOperator;
  threshold: number;
  severity: AlertSeverity;
}

export interface AlertRule {
  id: string;
  name: string;
  description?: string;
  tenantId?: string;
  farmId?: string;
  pondId?: string;
  sensorId?: string;
  conditions: AlertCondition[];
  severity?: AlertSeverity;
  isActive: boolean;
  notificationChannels?: string[];
  recipients?: string[];
  cooldownMinutes: number;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface AlertRulesFilter {
  farmId?: string;
  pondId?: string;
  isActive?: boolean;
}

export interface CreateAlertRuleInput {
  name: string;
  description?: string;
  farmId?: string;
  pondId?: string;
  sensorId?: string;
  conditions: AlertCondition[];
  notificationChannels?: string[];
  recipients?: string[];
  cooldownMinutes?: number;
}

export interface UpdateAlertRuleInput {
  ruleId: string;
  name?: string;
  description?: string;
  conditions?: AlertCondition[];
  notificationChannels?: string[];
  recipients?: string[];
  cooldownMinutes?: number;
  isActive?: boolean;
}

// ============================================================================
// Query Hooks
// ============================================================================

/**
 * Hook to fetch a single alert rule by ID
 */
export function useAlertRule(id: string) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'alertRule', id),
    queryFn: async () => {
      const data = await graphqlFetch<{ alertRule: AlertRule }>(
        ALERT_RULE_QUERY,
        { id },
      );
      return data.alertRule;
    },
    staleTime: 30000,
    enabled: !!id && !!tenantId,
  });
}

/**
 * Hook to fetch all alert rules with optional filters
 */
export function useAlertRules(filter?: AlertRulesFilter) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'alertRules', filter),
    queryFn: async () => {
      const vars: Record<string, unknown> = {};
      if (filter?.farmId) vars.farmId = filter.farmId;
      if (filter?.pondId) vars.pondId = filter.pondId;
      if (filter?.isActive !== undefined) vars.isActive = filter.isActive;

      const data = await graphqlFetch<{ alertRules: AlertRule[] }>(
        ALERT_RULES_QUERY,
        vars,
      );
      return data.alertRules;
    },
    staleTime: 30000,
    enabled: !!tenantId,
  });
}

// ============================================================================
// Mutation Hooks
// ============================================================================

/**
 * Hook to create a new alert rule
 */
export function useCreateAlertRule() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (input: CreateAlertRuleInput) => {
      const data = await graphqlFetch<{ createAlertRule: AlertRule }>(
        CREATE_ALERT_RULE_MUTATION,
        { input },
      );
      return data.createAlertRule;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'alertRules') });
    },
  });
}

/**
 * Hook to update an existing alert rule
 */
export function useUpdateAlertRule() {
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useMutation({
    mutationFn: async (input: UpdateAlertRuleInput) => {
      const data = await graphqlFetch<{ updateAlertRule: AlertRule }>(
        UPDATE_ALERT_RULE_MUTATION,
        { input },
      );
      return data.updateAlertRule;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'alertRules') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'alertRule', data.id) });
    },
  });
}

/**
 * Hook to delete an alert rule
 */
export function useDeleteAlertRule() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (ruleId: string) => {
      const data = await graphqlFetch<{ deleteAlertRule: boolean }>(
        DELETE_ALERT_RULE_MUTATION,
        { ruleId },
      );
      return data.deleteAlertRule;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'alertRules') });
    },
  });
}

/**
 * Hook to toggle alert rule active/inactive (convenience wrapper)
 */
export function useToggleAlertRule() {
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useMutation({
    mutationFn: async ({ ruleId, isActive }: { ruleId: string; isActive: boolean }) => {
      const data = await graphqlFetch<{ updateAlertRule: AlertRule }>(
        UPDATE_ALERT_RULE_MUTATION,
        { input: { ruleId, isActive } },
      );
      return data.updateAlertRule;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'alertRules') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'alertRule', data.id) });
    },
  });
}
