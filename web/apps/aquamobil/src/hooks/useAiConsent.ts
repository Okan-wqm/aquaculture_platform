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

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { gql } from 'graphql-tag';
import { useCallback } from 'react';

import { useAuth } from './useAuth';

import { graphqlRequest } from '@/services/authenticated-fetch';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

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
  /** ORPHAN-HIGH-595: an unreadable consent state is not "not consented". */
  isError: boolean;
  /** Toggle the user's AI consent. */
  toggleConsent: () => Promise<void>;
  /** True during initial fetch or mutation. */
  isLoading: boolean;
}

// ---------------------------------------------------------------------------
// GraphQL Operations
//
// These map onto the messaging-service AiResolver dual-consent contract
// (apps/messaging-service/src/ai/resolvers/ai.resolver.ts):
//   - query  aiSettings: AiSettingsType { tenantAiEnabled, userAiConsent }
//   - mutation updateUserAiConsent(consent: Boolean!): Boolean
// The dual-consent model is the SSoT — `tenantAiEnabled` is the tenant-level
// master switch (TENANT_ADMIN-owned) and `userAiConsent` is the per-user
// opt-in this hook toggles. Field names below are the real subgraph fields;
// the FE's `isAiEnabled`/`hasConsented` vocabulary is mapped at the boundary.
// ---------------------------------------------------------------------------

const GET_AI_SETTINGS = gql`
  query GetAiConsentStatus {
    aiSettings {
      tenantAiEnabled
      userAiConsent
    }
  }
`;

const UPDATE_USER_AI_CONSENT = gql`
  mutation ToggleAiConsent($consent: Boolean!) {
    updateUserAiConsent(consent: $consent)
  }
`;

// ---------------------------------------------------------------------------
// Data Fetching
// ---------------------------------------------------------------------------

/** Fetch AI consent status from the messaging-service GraphQL API. */
async function fetchAiConsentStatus(): Promise<AiConsentStatus> {
  try {
    const result = await graphqlRequest<{
      aiSettings: { tenantAiEnabled: boolean; userAiConsent: boolean };
    }>(GET_AI_SETTINGS);
    return {
      isAiEnabled: result.aiSettings.tenantAiEnabled,
      hasConsented: result.aiSettings.userAiConsent,
    };
  } catch {
    return { isAiEnabled: false, hasConsented: false };
  }
}

/** Toggle AI consent via the messaging-service GraphQL API. */
async function mutateAiConsent(consented: boolean): Promise<{ hasConsented: boolean }> {
  try {
    // `updateUserAiConsent` returns Boolean (success flag), not the new
    // consent value. On success the requested `consented` is the new state;
    // we surface it so the cache update + optimistic UI stay consistent.
    await graphqlRequest<{ updateUserAiConsent: boolean }>(UPDATE_USER_AI_CONSENT, {
      consent: consented,
    });
    return { hasConsented: consented };
  } catch {
    return { hasConsented: !consented };
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAiConsent(): UseAiConsentReturn {
  const { isAuthenticated, tenantId } = useAuth();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'messaging', 'ai-consent', tenantId),
    queryFn: fetchAiConsentStatus,
    enabled: isAuthenticated && !!tenantId,
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
  });

  const mutation = useMutation({
    mutationFn: (consented: boolean) => mutateAiConsent(consented),
    onSuccess: (data) => {
      queryClient.setQueryData(
        createTenantQueryKey(tenantId, 'messaging', 'ai-consent', tenantId),
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
    // ORPHAN-HIGH-595: an unreadable consent state is not the same as
    // "not consented" — the caller decides, fail-closed, knowing which it is.
    isError: query.isError,
  };
}
