/**
 * Panel messaging GraphQL operations — raw strings for graphqlClient.request.
 *
 * Written fresh against the CURRENT messaging subgraph schema (NOT copied from
 * aquamobil, whose CHANNEL_FIELDS still selects the pending-removal aiServiceUrl
 * — we deliberately do not select it so it can be dropped). Channels + messages
 * are tenant-scoped; the assistant/AI channels ride the same schema (aiPersona).
 */

const USER_FIELDS = `
  id
  firstName
  lastName
  profileImageUrl
`;

const MESSAGE_FIELDS = `
  id
  channelId
  senderId
  content
  contentType
  isDeleted
  isAiGenerated
  metadata
  createdAt
  editedAt
  sender { ${USER_FIELDS} }
`;

const CHANNEL_FIELDS = `
  id
  type
  name
  description
  avatarUrl
  isArchived
  aiPersona
  unreadCount
  memberCount
  createdAt
  updatedAt
  lastMessage { ${MESSAGE_FIELDS} }
  members {
    id
    userId
    role
    user { ${USER_FIELDS} }
  }
`;

export const MY_CHANNELS_QUERY = `
  query MyChannels($filter: ChannelFilterInput) {
    myChannels(filter: $filter) {
      total
      items { ${CHANNEL_FIELDS} }
    }
  }
`;

export const CHANNEL_MESSAGES_QUERY = `
  query ChannelMessages($channelId: ID!, $filter: MessageFilterInput) {
    messages(channelId: $channelId, filter: $filter) {
      hasMore
      cursor
      items { ${MESSAGE_FIELDS} }
    }
  }
`;

/**
 * sendMessage — idempotencyKey is REQUIRED (ID!) on the backend
 * (SendMessageInput.idempotencyKey, worktree dto/send-message.input.ts) and is
 * the at-most-once send key: a replay returns the previously created message.
 * The panel computes it ONCE per logical send (lib/messageIdempotency.ts) and
 * carries it in the mutation variables so retries reuse the same key.
 */
export const SEND_MESSAGE_MUTATION = `
  mutation SendMessage($input: SendMessageInput!) {
    sendMessage(input: $input) { ${MESSAGE_FIELDS} }
  }
`;

/**
 * markMessagesRead — advances the caller's lastReadAt cursor up to and
 * including `messageId` (backend message.resolver.ts markMessagesRead; input
 * MarkReadInput { channelId: ID!, messageId: ID! }). Returns Boolean and is a
 * no-op-safe monotonic update, so a redundant repeat (e.g. visibilitychange
 * re-fire) costs one cheap mutation, never a wrong unread state.
 */
export const MARK_MESSAGES_READ_MUTATION = `
  mutation MarkMessagesRead($input: MarkReadInput!) {
    markMessagesRead(input: $input)
  }
`;

// ── AI channels (FE-MEDIUM-065) ─────────────────────────────────────────────
// The persona list is filtered SERVER-side by the caller's capabilities
// (AiResolver.availableAiPersonas) — the panel renders what it is given and
// never re-derives authorization from the id.

export const AVAILABLE_AI_PERSONAS_QUERY = `
  query AvailableAiPersonas {
    availableAiPersonas {
      id
      name
      description
      icon
      color
      capabilities
    }
  }
`;

/**
 * Dual-consent read: `tenantAiEnabled` is the tenant master switch (owned by
 * ai-service), `userAiConsent` the per-user opt-in the bridge requires before
 * it answers in an AI channel (fail-closed: no consent → every message is
 * refused with an AI error notice).
 */
export const AI_SETTINGS_QUERY = `
  query AiSettings {
    aiSettings {
      tenantAiEnabled
      userAiConsent
    }
  }
`;

export const UPDATE_USER_AI_CONSENT_MUTATION = `
  mutation UpdateUserAiConsent($consent: Boolean!) {
    updateUserAiConsent(consent: $consent)
  }
`;

/**
 * createChannel for an AI room: `type: AI`, no members (the creator is added
 * server-side), `aiPersona` a published catalogue id or omitted for the
 * tenant default (CreateChannelInput.aiPersona — IsKnownAiPersonaId).
 */
export const CREATE_AI_CHANNEL_MUTATION = `
  mutation CreateAiChannel($input: CreateChannelInput!) {
    createChannel(input: $input) { ${CHANNEL_FIELDS} }
  }
`;
