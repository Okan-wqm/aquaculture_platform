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
import {
  useTenantQuery,
  useTenantMutation,
  graphqlClient,
  useAuth,
  createTenantInvalidationKey,
} from '@aquaculture/shared-ui';
import { useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';

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

/** Per-mutation cache context for the consent rollback. */
interface ConsentContext {
  previous: Array<[readonly unknown[], AiSettings | undefined]>;
}

/**
 * Set (not toggle) the user's AI consent. OPTIMISTIC: the switch shows the
 * requested value at once (a controlled checkbox that snaps back until the
 * refetch lands reads as "it did not take"), rolls back on error, and the
 * settings query is re-read on success so the server's truth wins.
 */
export function useUpdateAiConsent(): UseMutationResult<boolean, Error, boolean> {
  const { tenantId } = useAuth();
  const queryClient = useQueryClient();
  return useTenantMutation<boolean, Error, boolean>(
    async (consent: boolean) => {
      const data = await graphqlClient.request<UpdateUserAiConsentResult>(
        UPDATE_USER_AI_CONSENT_MUTATION,
        { consent },
      );
      return data.updateUserAiConsent;
    },
    {
      invalidate: [['messaging', 'ai-settings']],
      // (queryKey expressions inline createTenantInvalidationKey — the
      // no-bare-tenant-query-key lint gate requires the factory call inline.)
      onMutate: (consent) => {
        const previous = queryClient.getQueriesData<AiSettings | undefined>({
          queryKey: createTenantInvalidationKey(tenantId, 'messaging', 'ai-settings'),
        });
        queryClient.setQueriesData<AiSettings | undefined>(
          { queryKey: createTenantInvalidationKey(tenantId, 'messaging', 'ai-settings') },
          (old) => (old ? { ...old, userAiConsent: consent } : old),
        );
        return { previous } satisfies ConsentContext;
      },
      onError: (_error, _consent, context) => {
        const ctx = context as ConsentContext | undefined;
        for (const [key, value] of ctx?.previous ?? []) {
          queryClient.setQueryData(key, value);
        }
      },
    },
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
