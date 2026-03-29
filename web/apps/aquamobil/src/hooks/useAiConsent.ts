// ============================================================================
// useAiConsent — Hook for AI consent management
// ============================================================================

/**
 * WHY: AI analysis features require explicit user consent per GDPR/data
 * protection requirements. This hook manages:
 * - Whether AI is enabled at the tenant level
 * - Whether the current user has consented to AI analysis
 * - A mutation to toggle consent on/off
 *
 * The hook uses TanStack Query for caching and the GraphQL API for persistence.
 *
 * @returns isAiEnabled — tenant-level AI setting
 * @returns hasConsented — current user's consent status
 * @returns toggleConsent — mutation to toggle consent
 * @returns isLoading — true during initial fetch or mutation
 */

import { useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { graphqlRequest } from '@/services/authenticated-fetch';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AiConsentStatus {
  /** Whether AI features are enabled for this tenant. */
  isAiEnabled: boolean;
  /** Whether the current user has consented to AI analysis. */
  hasConsented: boolean;
}

interface UseAiConsentReturn {
  /** Whether AI features are enabled for this tenant. */
  isAiEnabled: boolean;
  /** Whether the current user has consented to AI analysis. */
  hasConsented: boolean;
  /** Toggle the user's AI consent. */
  toggleConsent: () => Promise<void>;
  /** True during initial fetch or mutation. */
  isLoading: boolean;
}

// ---------------------------------------------------------------------------
// GraphQL Operations (TODO: Move to graphql/messaging-operations.ts)
// ---------------------------------------------------------------------------

const GET_AI_CONSENT_STATUS = `
  query GetAiConsentStatus {
    aiConsentStatus {
      isAiEnabled
      hasConsented
    }
  }
`;

const TOGGLE_AI_CONSENT = `
  mutation ToggleAiConsent($consented: Boolean!) {
    toggleAiConsent(consented: $consented) {
      hasConsented
    }
  }
`;

// ---------------------------------------------------------------------------
// Data Fetching
// ---------------------------------------------------------------------------

async function fetchAiConsentStatus(): Promise<AiConsentStatus> {
  // TODO: Replace with real API call when backend is ready
  // const result = await graphqlRequest<{ aiConsentStatus: AiConsentStatus }>(
  //   GET_AI_CONSENT_STATUS,
  // );
  // return result.aiConsentStatus;

  return { isAiEnabled: false, hasConsented: false };
}

async function mutateAiConsent(consented: boolean): Promise<{ hasConsented: boolean }> {
  // TODO: Replace with real API call when backend is ready
  // const result = await graphqlRequest<{ toggleAiConsent: { hasConsented: boolean } }>(
  //   TOGGLE_AI_CONSENT,
  //   { consented },
  // );
  // return result.toggleAiConsent;

  return { hasConsented: consented };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAiConsent(): UseAiConsentReturn {
  const { isAuthenticated, tenantId } = useAuth();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['messaging', 'ai-consent', tenantId],
    queryFn: fetchAiConsentStatus,
    enabled: isAuthenticated && !!tenantId,
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
  });

  const mutation = useMutation({
    mutationFn: (consented: boolean) => mutateAiConsent(consented),
    onSuccess: (data) => {
      queryClient.setQueryData(
        ['messaging', 'ai-consent', tenantId],
        (prev: AiConsentStatus | undefined) =>
          prev ? { ...prev, hasConsented: data.hasConsented } : prev,
      );
    },
  });

  const toggleConsent = useCallback(async () => {
    const currentConsent = query.data?.hasConsented ?? false;
    await mutation.mutateAsync(!currentConsent);
  }, [query.data?.hasConsented, mutation]);

  return {
    isAiEnabled: query.data?.isAiEnabled ?? false,
    hasConsented: query.data?.hasConsented ?? false,
    toggleConsent,
    isLoading: query.isLoading || mutation.isPending,
  };
}
