/**
 * Tenant AI (BYOK) provider settings — read + update.
 *
 * Tenant-scoped query keys via createTenantQueryKey (web/ CLAUDE.md: cross-tenant
 * cache leak otherwise). Backed by the ai-service federated subgraph; the update
 * invalidates the read so the masked key hint + enablement reflect immediately.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createTenantQueryKey,
  createTenantInvalidationKey,
  getTenantId,
} from '@aquaculture/shared-ui';
import { graphqlRequest } from '../services/tenant-api.service';
import {
  AI_PROVIDER_SETTINGS_QUERY,
  UPDATE_AI_PROVIDER_SETTINGS_MUTATION,
} from '../graphql';

export type LlmProviderId = 'anthropic' | 'openai';

export interface AiProviderSettings {
  provider: LlmProviderId;
  isEnabled: boolean;
  /** 'ok' = ready; 'disabled' = turned off; 'key_missing' = no valid key. */
  enablementReason: 'ok' | 'disabled' | 'key_missing';
  anthropicKeyHint: string | null;
  openaiKeyHint: string | null;
  chatModel: string | null;
  monthlyTokenBudget: number;
  hourlyRequestLimit: number;
  availableProviders: LlmProviderId[];
}

/**
 * Update payload. Key semantics (write-only): a non-empty string SETS the key
 * (validated live before persisting); an empty string CLEARS it; an omitted
 * field leaves the stored key untouched — so a masked hint is never re-submitted.
 */
export interface UpdateAiProviderSettingsInput {
  provider?: LlmProviderId;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  chatModel?: string;
  isEnabled?: boolean;
  monthlyTokenBudget?: number;
  hourlyRequestLimit?: number;
}

const aiSettingsKey = (): readonly unknown[] =>
  createTenantQueryKey(getTenantId(), 'aiProviderSettings');

export function useAiProviderSettings() {
  return useQuery({
    queryKey: aiSettingsKey(),
    queryFn: async () => {
      const data = await graphqlRequest<{ aiProviderSettings: AiProviderSettings }>(
        AI_PROVIDER_SETTINGS_QUERY,
      );
      return data.aiProviderSettings;
    },
  });
}

export function useUpdateAiProviderSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateAiProviderSettingsInput) => {
      const data = await graphqlRequest<{
        updateAiProviderSettings: AiProviderSettings;
      }>(UPDATE_AI_PROVIDER_SETTINGS_MUTATION, { input });
      return data.updateAiProviderSettings;
    },
    onSuccess: (updated) => {
      // Seed the read cache with the fresh masked view, then invalidate so any
      // other observer refetches the authoritative state.
      queryClient.setQueryData(aiSettingsKey(), updated);
      void queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(getTenantId(), 'aiProviderSettings'),
      });
    },
  });
}
