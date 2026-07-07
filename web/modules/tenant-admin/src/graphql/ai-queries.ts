/**
 * GraphQL operations for the tenant's AI (BYOK) provider settings.
 *
 * Backed by the ai-service federated subgraph: `aiProviderSettings` (masked
 * read) + `updateAiProviderSettings` (write). Keys are NEVER returned in full —
 * only a `••••last4` hint — and a submitted key is validated live against the
 * provider before it persists. Gated by ai_settings:view / ai_settings:manage
 * (tenant-configurable RBAC, Faz 7c).
 */

export const AI_PROVIDER_SETTINGS_QUERY = `
  query AiProviderSettings {
    aiProviderSettings {
      provider
      isEnabled
      enablementReason
      anthropicKeyHint
      openaiKeyHint
      chatModel
      monthlyTokenBudget
      hourlyRequestLimit
      availableProviders
    }
  }
`;

export const UPDATE_AI_PROVIDER_SETTINGS_MUTATION = `
  mutation UpdateAiProviderSettings($input: UpdateAiSettingsInput!) {
    updateAiProviderSettings(input: $input) {
      provider
      isEnabled
      enablementReason
      anthropicKeyHint
      openaiKeyHint
      chatModel
      monthlyTokenBudget
      hourlyRequestLimit
      availableProviders
    }
  }
`;
