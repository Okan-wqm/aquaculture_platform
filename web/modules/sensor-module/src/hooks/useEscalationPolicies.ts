/**
 * React Query hooks for Escalation Policy CRUD operations
 *
 * Uses the alert-engine GraphQL API:
 * - escalationPolicy(id) query
 * - escalationPolicies(activeOnly) query
 * - defaultEscalationPolicy query
 * - currentOnCallUser(policyId) query
 * - createEscalationPolicy mutation
 * - updateEscalationPolicy mutation
 * - deleteEscalationPolicy mutation
 * - addSuppressionWindow mutation
 * - removeSuppressionWindow mutation
 * - updateOnCallSchedule mutation
 * - cloneEscalationPolicy mutation
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, createTenantQueryKey } from '@aquaculture/shared-ui';
import { graphqlFetch } from '../config/api';
import {
  ESCALATION_POLICY_QUERY,
  ESCALATION_POLICIES_QUERY,
  DEFAULT_ESCALATION_POLICY_QUERY,
  CURRENT_ON_CALL_USER_QUERY,
  CREATE_ESCALATION_POLICY_MUTATION,
  UPDATE_ESCALATION_POLICY_MUTATION,
  DELETE_ESCALATION_POLICY_MUTATION,
  ADD_SUPPRESSION_WINDOW_MUTATION,
  REMOVE_SUPPRESSION_WINDOW_MUTATION,
  UPDATE_ON_CALL_SCHEDULE_MUTATION,
  CLONE_ESCALATION_POLICY_MUTATION,
} from '../graphql/escalationPolicy.operations';

// ============================================================================
// Types
// ============================================================================

export type AlertSeverity = 'info' | 'low' | 'warning' | 'medium' | 'high' | 'critical';

export type EscalationActionType =
  | 'NOTIFY'
  | 'ASSIGN'
  | 'ESCALATE_TO_MANAGER'
  | 'CREATE_TICKET'
  | 'WEBHOOK'
  | 'AUTO_RESOLVE';

export type NotificationChannel =
  | 'EMAIL'
  | 'SMS'
  | 'SLACK'
  | 'TEAMS'
  | 'WEBHOOK'
  | 'PUSH'
  | 'PAGERDUTY';

export interface EscalationLevel {
  level: number;
  name: string;
  timeoutMinutes: number;
  notifyUserIds: string[];
  notifyTeamIds?: string[];
  channels: NotificationChannel[];
  action: EscalationActionType;
  actionConfig?: string;
  messageTemplate?: string;
}

export interface OnCallSchedule {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  userId: string;
  backupUserId?: string;
}

export interface SuppressionWindow {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  reason?: string;
  createdBy: string;
  isRecurring: boolean;
  recurringPattern?: string;
}

export interface EscalationPolicy {
  id: string;
  name: string;
  description?: string;
  tenantId: string;
  severity: AlertSeverity[];
  levels: EscalationLevel[];
  onCallSchedule?: OnCallSchedule[];
  suppressionWindows?: SuppressionWindow[];
  repeatIntervalMinutes: number;
  maxRepeats: number;
  isActive: boolean;
  isDefault: boolean;
  priority: number;
  conditions?: Record<string, unknown>;
  timezone?: string;
  ruleIds?: string[];
  farmIds?: string[];
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface CreateEscalationPolicyInput {
  name: string;
  description?: string;
  severity: AlertSeverity[];
  levels: EscalationLevel[];
  onCallSchedule?: OnCallSchedule[];
  suppressionWindows?: SuppressionWindowInput[];
  repeatIntervalMinutes?: number;
  maxRepeats?: number;
  isDefault?: boolean;
  priority?: number;
  timezone?: string;
  ruleIds?: string[];
  farmIds?: string[];
}

export interface UpdateEscalationPolicyInput {
  policyId: string;
  name?: string;
  description?: string;
  severity?: AlertSeverity[];
  levels?: EscalationLevel[];
  onCallSchedule?: OnCallSchedule[];
  repeatIntervalMinutes?: number;
  maxRepeats?: number;
  isActive?: boolean;
  isDefault?: boolean;
  priority?: number;
  timezone?: string;
  ruleIds?: string[];
  farmIds?: string[];
}

export interface SuppressionWindowInput {
  name: string;
  startTime: string;
  endTime: string;
  reason?: string;
  isRecurring: boolean;
  recurringPattern?: string;
}

export interface AddSuppressionWindowInput {
  policyId: string;
  window: SuppressionWindowInput;
}

export interface UpdateOnCallScheduleInput {
  policyId: string;
  schedule: OnCallSchedule[];
}

export interface ClonePolicyInput {
  policyId: string;
  newName: string;
}

// ============================================================================
// Query Keys
// ============================================================================

const QUERY_KEYS = {
  policies: ['escalationPolicies'] as const,
  policy: (id: string) => ['escalationPolicy', id] as const,
  defaultPolicy: ['defaultEscalationPolicy'] as const,
  onCallUser: (policyId: string) => ['currentOnCallUser', policyId] as const,
};

// ============================================================================
// Query Hooks
// ============================================================================

/**
 * Hook to fetch a single escalation policy by ID
 */
export function useEscalationPolicy(id: string) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: QUERY_KEYS.policy(id),
    queryFn: async () => {
      const data = await graphqlFetch<{ escalationPolicy: EscalationPolicy }>(
        ESCALATION_POLICY_QUERY,
        { id },
      );
      return data.escalationPolicy;
    },
    staleTime: 30000,
    enabled: !!id && !!tenantId,
  });
}

/**
 * Hook to fetch all escalation policies
 */
export function useEscalationPolicies(activeOnly = false) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, ...QUERY_KEYS.policies, { activeOnly }),
    queryFn: async () => {
      const data = await graphqlFetch<{ escalationPolicies: EscalationPolicy[] }>(
        ESCALATION_POLICIES_QUERY,
        { activeOnly },
      );
      return data.escalationPolicies;
    },
    staleTime: 30000,
    enabled: !!tenantId,
  });
}

/**
 * Hook to fetch the default escalation policy
 */
export function useDefaultEscalationPolicy() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: QUERY_KEYS.defaultPolicy,
    queryFn: async () => {
      const data = await graphqlFetch<{ defaultEscalationPolicy: EscalationPolicy | null }>(
        DEFAULT_ESCALATION_POLICY_QUERY,
      );
      return data.defaultEscalationPolicy;
    },
    staleTime: 60000,
  });
}

/**
 * Hook to fetch current on-call user for a policy
 */
export function useCurrentOnCallUser(policyId: string) {
  return useQuery({
    queryKey: QUERY_KEYS.onCallUser(policyId),
    queryFn: async () => {
      const data = await graphqlFetch<{ currentOnCallUser: string | null }>(
        CURRENT_ON_CALL_USER_QUERY,
        { policyId },
      );
      return data.currentOnCallUser;
    },
    staleTime: 60000,
    enabled: !!policyId,
  });
}

// ============================================================================
// Mutation Hooks
// ============================================================================

/**
 * Hook to create a new escalation policy
 */
export function useCreateEscalationPolicy() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (input: CreateEscalationPolicyInput) => {
      const data = await graphqlFetch<{ createEscalationPolicy: EscalationPolicy }>(
        CREATE_ESCALATION_POLICY_MUTATION,
        { input },
      );
      return data.createEscalationPolicy;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.policies });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.defaultPolicy });
    },
  });
}

/**
 * Hook to update an existing escalation policy
 */
export function useUpdateEscalationPolicy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateEscalationPolicyInput) => {
      const data = await graphqlFetch<{ updateEscalationPolicy: EscalationPolicy }>(
        UPDATE_ESCALATION_POLICY_MUTATION,
        { input },
      );
      return data.updateEscalationPolicy;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.policies });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.policy(data.id) });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.defaultPolicy });
    },
  });
}

/**
 * Hook to delete an escalation policy
 */
export function useDeleteEscalationPolicy() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (policyId: string) => {
      const data = await graphqlFetch<{ deleteEscalationPolicy: boolean }>(
        DELETE_ESCALATION_POLICY_MUTATION,
        { policyId },
      );
      return data.deleteEscalationPolicy;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.policies });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.defaultPolicy });
    },
  });
}

/**
 * Hook to add a suppression window to a policy
 */
export function useAddSuppressionWindow() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: AddSuppressionWindowInput) => {
      const data = await graphqlFetch<{ addSuppressionWindow: EscalationPolicy }>(
        ADD_SUPPRESSION_WINDOW_MUTATION,
        { input },
      );
      return data.addSuppressionWindow;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.policies });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.policy(data.id) });
    },
  });
}

/**
 * Hook to remove a suppression window from a policy
 */
export function useRemoveSuppressionWindow() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async ({ policyId, windowId }: { policyId: string; windowId: string }) => {
      const data = await graphqlFetch<{ removeSuppressionWindow: EscalationPolicy }>(
        REMOVE_SUPPRESSION_WINDOW_MUTATION,
        { policyId, windowId },
      );
      return data.removeSuppressionWindow;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.policies });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.policy(data.id) });
    },
  });
}

/**
 * Hook to update on-call schedule for a policy
 */
export function useUpdateOnCallSchedule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateOnCallScheduleInput) => {
      const data = await graphqlFetch<{ updateOnCallSchedule: EscalationPolicy }>(
        UPDATE_ON_CALL_SCHEDULE_MUTATION,
        { input },
      );
      return data.updateOnCallSchedule;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.policies });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.policy(data.id) });
    },
  });
}

/**
 * Hook to clone an escalation policy
 */
export function useCloneEscalationPolicy() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (input: ClonePolicyInput) => {
      const data = await graphqlFetch<{ cloneEscalationPolicy: EscalationPolicy }>(
        CLONE_ESCALATION_POLICY_MUTATION,
        { input },
      );
      return data.cloneEscalationPolicy;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.policies });
    },
  });
}

/**
 * Hook to toggle escalation policy active/inactive (convenience wrapper)
 */
export function useToggleEscalationPolicy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ policyId, isActive }: { policyId: string; isActive: boolean }) => {
      const data = await graphqlFetch<{ updateEscalationPolicy: EscalationPolicy }>(
        UPDATE_ESCALATION_POLICY_MUTATION,
        { input: { policyId, isActive } },
      );
      return data.updateEscalationPolicy;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.policies });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.policy(data.id) });
    },
  });
}
