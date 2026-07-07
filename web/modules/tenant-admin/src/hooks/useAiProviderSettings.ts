/**
 * Tenant AI (BYOK) provider settings — read + update.
 *
 * Uses the useTenantQuery / useTenantMutation SSoT (tenant-scoped keys +
 * invalidation are handled for you — web/ CLAUDE.md cross-tenant cache rule).
 * Backed by the ai-service federated subgraph; the update invalidates the read
 * so the masked key hint + enablement reflect immediately.
 */
import { useTenantQuery, useTenantMutation } from '@aquaculture/shared-ui';
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

/** Domain key segments — the tenant prefix + epoch are added by useTenantQuery. */
const AI_SETTINGS_SEGMENTS = ['aiProviderSettings'] as const;

export function useAiProviderSettings() {
  return useTenantQuery<AiProviderSettings>(AI_SETTINGS_SEGMENTS, async () => {
    const data = await graphqlRequest<{ aiProviderSettings: AiProviderSettings }>(
      AI_PROVIDER_SETTINGS_QUERY,
    );
    return data.aiProviderSettings;
  });
}

export function useUpdateAiProviderSettings() {
  return useTenantMutation<AiProviderSettings, Error, UpdateAiProviderSettingsInput>(
    async (input) => {
      const data = await graphqlRequest<{
        updateAiProviderSettings: AiProviderSettings;
      }>(UPDATE_AI_PROVIDER_SETTINGS_MUTATION, { input });
      return data.updateAiProviderSettings;
    },
    { invalidate: [AI_SETTINGS_SEGMENTS] },
  );
}
