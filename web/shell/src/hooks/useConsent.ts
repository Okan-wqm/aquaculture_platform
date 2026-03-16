/**
 * useConsent Hook
 *
 * GDPR consent management hook using @tanstack/react-query.
 * Provides queries and mutations for user consent operations.
 */

import { useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { graphqlClient } from '@aquaculture/shared-ui';
import {
  MY_CONSENT_STATUS_QUERY,
  MY_CONSENT_HISTORY_QUERY,
  IS_CONSENT_OUTDATED_QUERY,
  CURRENT_CONSENT_VERSION_QUERY,
  RECORD_CONSENT_MUTATION,
  RECORD_BULK_CONSENT_MUTATION,
  WITHDRAW_CONSENT_MUTATION,
} from '../graphql/consent.operations';

// ============================================================================
// Types
// ============================================================================

export type ConsentType =
  | 'ESSENTIAL'
  | 'ANALYTICS'
  | 'MARKETING'
  | 'THIRD_PARTY'
  | 'DATA_PROCESSING'
  | 'DATA_SHARING'
  | 'PROFILING';

export interface ConsentStatusItem {
  consentType: ConsentType;
  granted: boolean;
}

export interface UserConsentStatus {
  userId: string;
  lastUpdated: string;
  consentVersion: string;
  isOutdated: boolean;
  consents: ConsentStatusItem[];
}

export interface UserConsentRecord {
  id: string;
  userId: string;
  consentType: ConsentType;
  granted: boolean;
  version: string;
  createdAt: string;
  expiresAt: string | null;
  isActive: boolean;
}

export interface ConsentHistoryResponse {
  records: UserConsentRecord[];
  totalCount: number;
}

export interface RecordConsentInput {
  consentType: ConsentType;
  granted: boolean;
  version?: string;
}

export interface RecordConsentResult {
  id: string;
  success: boolean;
  message: string;
}

export interface BulkConsentResult {
  ids: string[];
  success: boolean;
  message: string;
  recordedCount: number;
}

export interface WithdrawConsentResult {
  success: boolean;
  message: string;
  consentType: ConsentType;
}

// ============================================================================
// Query Keys
// ============================================================================

export const consentKeys = {
  all: ['consent'] as const,
  status: () => [...consentKeys.all, 'status'] as const,
  history: (limit?: number, offset?: number) =>
    [...consentKeys.all, 'history', { limit, offset }] as const,
  outdated: () => [...consentKeys.all, 'outdated'] as const,
  version: () => [...consentKeys.all, 'version'] as const,
};

// ============================================================================
// Consent Status Label Mapping
// ============================================================================

export const CONSENT_TYPE_LABELS: Record<ConsentType, { label: string; description: string }> = {
  ESSENTIAL: {
    label: 'Essential Services',
    description: 'Required for the platform to function properly. Cannot be disabled.',
  },
  DATA_PROCESSING: {
    label: 'Data Processing',
    description: 'Allow processing of your aquaculture and operational data for service delivery.',
  },
  ANALYTICS: {
    label: 'Analytics',
    description: 'Allow collection of usage data to improve the platform experience.',
  },
  MARKETING: {
    label: 'Marketing Communications',
    description: 'Receive product updates, newsletters, and promotional content.',
  },
  THIRD_PARTY: {
    label: 'Third-Party Integrations',
    description: 'Allow sharing data with approved third-party service providers.',
  },
  DATA_SHARING: {
    label: 'Data Sharing',
    description: 'Allow sharing aggregated or anonymized data for research and benchmarking.',
  },
  PROFILING: {
    label: 'Profiling',
    description: 'Allow creation of usage profiles for personalized recommendations.',
  },
};

// ============================================================================
// Hook
// ============================================================================

export function useConsent() {
  const queryClient = useQueryClient();

  // ── Queries ──────────────────────────────────────────────────────────

  /**
   * Fetch current consent status
   */
  const statusQuery = useQuery({
    queryKey: consentKeys.status(),
    queryFn: async () => {
      const data = await graphqlClient.request<{ myConsentStatus: UserConsentStatus }>(
        MY_CONSENT_STATUS_QUERY,
      );
      return data.myConsentStatus;
    },
    staleTime: 2 * 60 * 1000, // 2 minutes
    retry: 1, // Don't block UI with excessive retries
  });

  /**
   * Check if consent is outdated (lightweight check for the banner)
   */
  const outdatedQuery = useQuery({
    queryKey: consentKeys.outdated(),
    queryFn: async () => {
      const data = await graphqlClient.request<{ isConsentOutdated: boolean }>(
        IS_CONSENT_OUTDATED_QUERY,
      );
      return data.isConsentOutdated;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 1, // Don't block UI with excessive retries
  });

  /**
   * Get current consent version
   */
  const versionQuery = useQuery({
    queryKey: consentKeys.version(),
    queryFn: async () => {
      const data = await graphqlClient.request<{ currentConsentVersion: string }>(
        CURRENT_CONSENT_VERSION_QUERY,
      );
      return data.currentConsentVersion;
    },
    staleTime: 10 * 60 * 1000, // 10 minutes
  });

  // ── Mutations ────────────────────────────────────────────────────────

  /**
   * Record a single consent
   */
  const recordConsentMutation = useMutation({
    mutationFn: async (input: RecordConsentInput) => {
      const data = await graphqlClient.request<{ recordConsent: RecordConsentResult }>(
        RECORD_CONSENT_MUTATION,
        { input },
      );
      return data.recordConsent;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: consentKeys.all });
    },
  });

  /**
   * Record multiple consents at once (bulk)
   */
  const recordBulkConsentMutation = useMutation({
    mutationFn: async (consents: Array<{ consentType: ConsentType; granted: boolean }>) => {
      const data = await graphqlClient.request<{ recordBulkConsent: BulkConsentResult }>(
        RECORD_BULK_CONSENT_MUTATION,
        { input: { consents } },
      );
      return data.recordBulkConsent;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: consentKeys.all });
    },
  });

  /**
   * Withdraw a consent
   */
  const withdrawConsentMutation = useMutation({
    mutationFn: async (input: { consentType: ConsentType; reason?: string }) => {
      const data = await graphqlClient.request<{ withdrawConsent: WithdrawConsentResult }>(
        WITHDRAW_CONSENT_MUTATION,
        { input },
      );
      return data.withdrawConsent;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: consentKeys.all });
    },
  });

  // ── Convenience Methods ──────────────────────────────────────────────

  const toggleConsent = useCallback(
    async (consentType: ConsentType, granted: boolean) => {
      if (granted) {
        return recordConsentMutation.mutateAsync({ consentType, granted: true });
      } else {
        return withdrawConsentMutation.mutateAsync({ consentType });
      }
    },
    [recordConsentMutation, withdrawConsentMutation],
  );

  return {
    // Status
    status: statusQuery.data ?? null,
    isStatusLoading: statusQuery.isLoading,
    statusError: statusQuery.error,
    refetchStatus: statusQuery.refetch,

    // Outdated check
    isOutdated: outdatedQuery.data ?? false,
    isOutdatedLoading: outdatedQuery.isLoading,

    // Version
    currentVersion: versionQuery.data ?? null,

    // Mutations
    recordConsent: recordConsentMutation.mutateAsync,
    isRecordingConsent: recordConsentMutation.isPending,
    recordBulkConsent: recordBulkConsentMutation.mutateAsync,
    isBulkRecording: recordBulkConsentMutation.isPending,
    withdrawConsent: withdrawConsentMutation.mutateAsync,
    isWithdrawing: withdrawConsentMutation.isPending,

    // Convenience
    toggleConsent,
    isMutating:
      recordConsentMutation.isPending ||
      recordBulkConsentMutation.isPending ||
      withdrawConsentMutation.isPending,
  };
}

/**
 * Separate hook for consent history with pagination.
 * Must be called at the top level of a component (Rules of Hooks).
 */
export function useConsentHistory(limit = 50, offset = 0) {
  return useQuery({
    queryKey: consentKeys.history(limit, offset),
    queryFn: async () => {
      const data = await graphqlClient.request<{ myConsentHistory: ConsentHistoryResponse }>(
        MY_CONSENT_HISTORY_QUERY,
        { limit, offset },
      );
      return data.myConsentHistory;
    },
    staleTime: 60 * 1000, // 1 minute
  });
}

export default useConsent;
