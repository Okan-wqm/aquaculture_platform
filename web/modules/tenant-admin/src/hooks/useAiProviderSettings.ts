/**
 * Tenant AI (BYOK) provider settings — read + update.
 *
 * Uses the useTenantQuery / useTenantMutation SSoT (tenant-scoped keys +
 * invalidation are handled for you — web/ CLAUDE.md cross-tenant cache rule).
 * Backed by the ai-service federated subgraph; the update invalidates the read
 * so the masked key hint + enablement reflect immediately.
 */
import { useTenantQuery, useTenantMutation } from '@aquaculture/shared-ui';
import {
  getAiProviderSettings,
  updateAiProviderSettings,
  type AiProviderSettings,
  type UpdateAiProviderSettingsInput,
} from '../lib/api';

export type { AiProviderSettings, UpdateAiProviderSettingsInput } from '../lib/api';
export type { LlmProviderId } from '../lib/api';

/**
 * Update payload. Key semantics (write-only): a non-empty string SETS the key
 * (validated live before persisting); an empty string CLEARS it; an omitted
 * field leaves the stored key untouched — so a masked hint is never re-submitted.
 */
/** Domain key segments — the tenant prefix + epoch are added by useTenantQuery. */
const AI_SETTINGS_SEGMENTS = ['aiProviderSettings'] as const;

export function useAiProviderSettings() {
  return useTenantQuery<AiProviderSettings>(AI_SETTINGS_SEGMENTS, getAiProviderSettings);
}

export function useUpdateAiProviderSettings() {
  return useTenantMutation<AiProviderSettings, Error, UpdateAiProviderSettingsInput>(
    updateAiProviderSettings,
    { invalidate: [AI_SETTINGS_SEGMENTS] },
  );
}
