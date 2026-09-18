/**
 * Panel AI-channel hooks — persona picker, dual consent, AI room creation
 * (FE-MEDIUM-065).
 *
 * Uses the useTenantQuery / useTenantMutation SSoT (tenant-scoped keys +
 * invalidation) + the shared graphqlClient, exactly like useMessagingData.
 *
 * Consent is the bridge's fail-closed gate: an AI channel whose member has
 * not opted in gets an AI error notice for every message. The panel therefore
 * surfaces the opt-in wherever an AI room is created or opened, instead of
 * letting the user discover the refusal message by message.
 */
import { useTenantQuery, useTenantMutation, graphqlClient } from '@aquaculture/shared-ui';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

import {
  AVAILABLE_AI_PERSONAS_QUERY,
  AI_SETTINGS_QUERY,
  UPDATE_USER_AI_CONSENT_MUTATION,
  CREATE_AI_CHANNEL_MUTATION,
} from '../graphql/messaging-operations';
import type { AiPersona, AiSettings, Channel } from '../types/messaging';

interface AvailableAiPersonasResult {
  availableAiPersonas: AiPersona[];
}
interface AiSettingsResult {
  aiSettings: AiSettings;
}
interface UpdateUserAiConsentResult {
  updateUserAiConsent: boolean;
}
interface CreateAiChannelResult {
  createChannel: Channel;
}

/** The personas THIS user may pin — server-filtered, tenant-default entry first. */
export function useAvailableAiPersonas(enabled = true): UseQueryResult<AiPersona[], Error> {
  return useTenantQuery<AiPersona[]>(
    ['messaging', 'ai-personas'],
    async () => {
      const data = await graphqlClient.request<AvailableAiPersonasResult>(
        AVAILABLE_AI_PERSONAS_QUERY,
      );
      return data.availableAiPersonas;
    },
    { enabled, staleTime: 5 * 60 * 1000 },
  );
}

/** Tenant master switch + this user's opt-in. */
export function useAiSettings(enabled = true): UseQueryResult<AiSettings, Error> {
  return useTenantQuery<AiSettings>(
    ['messaging', 'ai-settings'],
    async () => {
      const data = await graphqlClient.request<AiSettingsResult>(AI_SETTINGS_QUERY);
      return data.aiSettings;
    },
    { enabled, staleTime: 5 * 60 * 1000 },
  );
}

/**
 * Set (not toggle) the user's AI consent; the settings query is re-read on
 * success so the UI reflects the server's truth rather than the request.
 */
export function useUpdateAiConsent(): UseMutationResult<boolean, Error, boolean> {
  return useTenantMutation<boolean, Error, boolean>(
    async (consent: boolean) => {
      const data = await graphqlClient.request<UpdateUserAiConsentResult>(
        UPDATE_USER_AI_CONSENT_MUTATION,
        { consent },
      );
      return data.updateUserAiConsent;
    },
    { invalidate: [['messaging', 'ai-settings']] },
  );
}

export interface CreateAiChannelVariables {
  /** Published persona id, or null for the tenant default. */
  aiPersona: string | null;
  name: string;
}

/** Create an AI room; the creator is the only member (added server-side). */
export function useCreateAiChannel(): UseMutationResult<Channel, Error, CreateAiChannelVariables> {
  return useTenantMutation<Channel, Error, CreateAiChannelVariables>(
    async ({ aiPersona, name }) => {
      const data = await graphqlClient.request<CreateAiChannelResult>(CREATE_AI_CHANNEL_MUTATION, {
        input: {
          type: 'AI',
          name,
          memberIds: [],
          ...(aiPersona === null ? {} : { aiPersona }),
        },
      });
      return data.createChannel;
    },
    { invalidate: [['messaging', 'channels']] },
  );
}
