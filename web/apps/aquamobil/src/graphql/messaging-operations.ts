// ============================================================================
// Messaging GraphQL Operations — ADR-012 / S1-CODEGEN
// ============================================================================
// All queries and mutations for the in-app messaging feature.
// Matches the messaging-service GraphQL schema (ADR-012 section 6.2).
// Note: tenantId/userId come from @Tenant() and @CurrentUser() backend
// decorators, NOT from GraphQL variables. They are extracted from JWT.
//
// S1-CODEGEN: every operation is a real `gql`-tagged document with named
// GraphQL fragments (NOT JS `${...}` string interpolation), so graphql-codegen's
// graphql-tag-pluck can extract them and generate a TypedDocumentNode + result
// types per operation into ../generated/graphql.ts. Importing those generated
// constants in the hooks makes operation-result drift a compile error and the
// enum wire-casing class structurally impossible.

import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { gql } from 'graphql-tag';


import type {
  MyChannelsQuery,
  MyChannelsQueryVariables,
  GetChannelQuery,
  GetChannelQueryVariables,
  GetMessagesQuery,
  GetMessagesQueryVariables,
  MessagesSinceQuery,
  MessagesSinceQueryVariables,
  AllMessagesSinceQuery,
  AllMessagesSinceQueryVariables,
  TotalUnreadMessageCountQuery,
  TotalUnreadMessageCountQueryVariables,
  SearchMessagesQuery,
  SearchMessagesQueryVariables,
  GetPinnedMessagesQuery,
  GetPinnedMessagesQueryVariables,
  UserPresenceQuery,
  UserPresenceQueryVariables,
  DirectChannelQuery,
  DirectChannelQueryVariables,
  AvailableAiPersonasQuery,
  AvailableAiPersonasQueryVariables,
  CreateChannelMutation,
  CreateChannelMutationVariables,
  UpdateChannelMutation,
  UpdateChannelMutationVariables,
  ArchiveChannelMutation,
  ArchiveChannelMutationVariables,
  AddChannelMemberMutation,
  AddChannelMemberMutationVariables,
  RemoveChannelMemberMutation,
  RemoveChannelMemberMutationVariables,
  UpdateNotificationPreferenceMutation,
  UpdateNotificationPreferenceMutationVariables,
  SendMessageMutation,
  SendMessageMutationVariables,
  EditMessageMutation,
  EditMessageMutationVariables,
  DeleteMessageMutation,
  DeleteMessageMutationVariables,
  MarkMessagesReadMutation,
  MarkMessagesReadMutationVariables,
  RequestMediaUploadMutation,
  RequestMediaUploadMutationVariables,
  PinMessageMutation,
  PinMessageMutationVariables,
  UnpinMessageMutation,
  UnpinMessageMutationVariables,
  AddReactionMutation,
  AddReactionMutationVariables,
  RemoveReactionMutation,
  RemoveReactionMutationVariables,
  ForwardMessageMutation,
  ForwardMessageMutationVariables,
  MobileSentimentTrendsQuery,
  MobileSentimentTrendsQueryVariables,
  MobileConfirmAiActionMutation,
  MobileConfirmAiActionMutationVariables,
} from '@/generated/graphql';

// --- Reusable fragments ---
// MessageFields/ChannelFields are named GraphQL fragments interpolated into the
// operations below via fragment-document interpolation (the gql tag stitches the
// fragment definitions into each document at parse time).
//
// S1-CODEGEN: each operation is annotated with its generated
// `TypedDocumentNode<XQuery, XQueryVariables>` type. A plain `gql` DocumentNode
// is structurally assignable to TypedDocumentNode (the result/variable brand is
// an optional phantom member), so this annotation needs NO cast — it just flows
// the generated result + variable types into `graphqlRequest`, making any
// query/result drift a COMPILE error at the call site. The gql template remains
// the codegen pluck source, so the annotation can never silently diverge from
// the document: regenerating updates the referenced XQuery type.

export const MESSAGE_FIELDS = gql`
  fragment MessageFields on Message {
    id
    channelId
    senderId
    content
    contentType
    parentId
    forwardedFrom
    isDeleted
    createdAt
    editedAt
    sender {
      id
      firstName
      lastName
      profileImageUrl
      isOnline
    }
    attachments {
      id
      originalFilename
      mimeType
      fileSize
      width
      height
      durationSeconds
      thumbnailUrl
      downloadUrl
    }
    receipts {
      userId
      status
      deliveredAt
      readAt
    }
    reactionSummary {
      emoji
      count
      userIds
      hasReacted
    }
  }
`;

export const CHANNEL_FIELDS = gql`
  fragment ChannelFields on Channel {
    id
    type
    name
    description
    avatarUrl
    createdBy
    isArchived
    createdAt
    updatedAt
    aiPersona
    aiServiceUrl
    unreadCount
    memberCount
    lastMessage {
      ...MessageFields
    }
    members {
      id
      channelId
      userId
      role
      notificationPreference
      lastReadAt
      joinedAt
      leftAt
      user {
        id
        firstName
        lastName
        profileImageUrl
        isOnline
      }
    }
  }
  ${MESSAGE_FIELDS}
`;

// ============================================================================
// Queries
// ============================================================================

/** List channels for the current user, sorted by last message timestamp. */
export const MY_CHANNELS: TypedDocumentNode<MyChannelsQuery, MyChannelsQueryVariables> = gql`
  query MyChannels($filter: ChannelFilterInput) {
    myChannels(filter: $filter) {
      items {
        ...ChannelFields
      }
      total
    }
  }
  ${CHANNEL_FIELDS}
`;

/** Get a single channel by ID (must be a member). */
export const GET_CHANNEL: TypedDocumentNode<GetChannelQuery, GetChannelQueryVariables> = gql`
  query GetChannel($id: ID!) {
    channel(id: $id) {
      ...ChannelFields
    }
  }
  ${CHANNEL_FIELDS}
`;

/** Get paginated messages in a channel (cursor-based, newest first). */
export const GET_MESSAGES: TypedDocumentNode<GetMessagesQuery, GetMessagesQueryVariables> = gql`
  query GetMessages($channelId: ID!, $filter: MessageFilterInput) {
    messages(channelId: $channelId, filter: $filter) {
      items {
        ...MessageFields
      }
      hasMore
      cursor
    }
  }
  ${MESSAGE_FIELDS}
`;

/** Get messages since a timestamp for a single channel (offline sync). */
export const MESSAGES_SINCE: TypedDocumentNode<MessagesSinceQuery, MessagesSinceQueryVariables> = gql`
  query MessagesSince($channelId: ID!, $since: DateTime!) {
    messagesSince(channelId: $channelId, since: $since) {
      ...MessageFields
    }
  }
  ${MESSAGE_FIELDS}
`;

/** Bulk offline sync — all new messages across all channels since timestamp. */
export const ALL_MESSAGES_SINCE: TypedDocumentNode<AllMessagesSinceQuery, AllMessagesSinceQueryVariables> = gql`
  query AllMessagesSince($since: DateTime!, $limit: Int, $syncToken: String) {
    allMessagesSince(since: $since, limit: $limit, syncToken: $syncToken) {
      messages {
        ...MessageFields
      }
      hasMore
      syncToken
    }
  }
  ${MESSAGE_FIELDS}
`;

/** Get total unread message count across all channels. */
export const TOTAL_UNREAD_MESSAGE_COUNT: TypedDocumentNode<TotalUnreadMessageCountQuery, TotalUnreadMessageCountQueryVariables> = gql`
  query TotalUnreadMessageCount {
    totalUnreadMessageCount
  }
`;

/** Full-text search across messages. */
export const SEARCH_MESSAGES: TypedDocumentNode<SearchMessagesQuery, SearchMessagesQueryVariables> = gql`
  query SearchMessages($input: SearchMessagesInput!) {
    searchMessages(input: $input) {
      ...MessageFields
    }
  }
  ${MESSAGE_FIELDS}
`;

/** Get pinned messages in a channel. */
export const GET_PINNED_MESSAGES: TypedDocumentNode<GetPinnedMessagesQuery, GetPinnedMessagesQueryVariables> = gql`
  query GetPinnedMessages($channelId: ID!) {
    pinnedMessages(channelId: $channelId) {
      id
      channelId
      pinnedBy
      pinnedAt
      message {
        ...MessageFields
      }
    }
  }
  ${MESSAGE_FIELDS}
`;

/** Get online/offline status for a list of user IDs. */
export const USER_PRESENCE: TypedDocumentNode<UserPresenceQuery, UserPresenceQueryVariables> = gql`
  query UserPresence($userIds: [ID!]!) {
    userPresence(userIds: $userIds) {
      id
      firstName
      lastName
      profileImageUrl
      isOnline
    }
  }
`;

/** Get or create a DM channel with another user. */
export const DIRECT_CHANNEL: TypedDocumentNode<DirectChannelQuery, DirectChannelQueryVariables> = gql`
  query DirectChannel($userId: ID!) {
    directChannel(userId: $userId) {
      ...ChannelFields
    }
  }
  ${CHANNEL_FIELDS}
`;

/** Get available AI personas for the current tenant. */
export const AVAILABLE_AI_PERSONAS: TypedDocumentNode<AvailableAiPersonasQuery, AvailableAiPersonasQueryVariables> = gql`
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

// ============================================================================
// Mutations
// ============================================================================

/** Create a new group channel. */
export const CREATE_CHANNEL: TypedDocumentNode<CreateChannelMutation, CreateChannelMutationVariables> = gql`
  mutation CreateChannel($input: CreateChannelInput!) {
    createChannel(input: $input) {
      ...ChannelFields
    }
  }
  ${CHANNEL_FIELDS}
`;

/** Update channel name, description, or avatar. */
export const UPDATE_CHANNEL: TypedDocumentNode<UpdateChannelMutation, UpdateChannelMutationVariables> = gql`
  mutation UpdateChannel($id: ID!, $input: UpdateChannelInput!) {
    updateChannel(id: $id, input: $input) {
      ...ChannelFields
    }
  }
  ${CHANNEL_FIELDS}
`;

/** Archive (soft-delete) a channel. */
export const ARCHIVE_CHANNEL: TypedDocumentNode<ArchiveChannelMutation, ArchiveChannelMutationVariables> = gql`
  mutation ArchiveChannel($id: ID!) {
    archiveChannel(id: $id)
  }
`;

/** Add a member to a channel. */
export const ADD_CHANNEL_MEMBER: TypedDocumentNode<AddChannelMemberMutation, AddChannelMemberMutationVariables> = gql`
  mutation AddChannelMember($channelId: ID!, $userId: ID!, $role: ChannelMemberRole) {
    addChannelMember(channelId: $channelId, userId: $userId, role: $role) {
      id
      channelId
      userId
      role
      notificationPreference
      joinedAt
      user {
        id
        firstName
        lastName
        profileImageUrl
        isOnline
      }
    }
  }
`;

/** Remove a member from a channel (or leave). */
export const REMOVE_CHANNEL_MEMBER: TypedDocumentNode<RemoveChannelMemberMutation, RemoveChannelMemberMutationVariables> = gql`
  mutation RemoveChannelMember($channelId: ID!, $userId: ID!) {
    removeChannelMember(channelId: $channelId, userId: $userId)
  }
`;

/** Update notification preference for a channel. */
export const UPDATE_NOTIFICATION_PREFERENCE: TypedDocumentNode<UpdateNotificationPreferenceMutation, UpdateNotificationPreferenceMutationVariables> = gql`
  mutation UpdateNotificationPreference($channelId: ID!, $preference: NotificationPreference!) {
    updateNotificationPreference(channelId: $channelId, preference: $preference) {
      id
      notificationPreference
    }
  }
`;

/** Send a message to a channel. */
export const SEND_MESSAGE: TypedDocumentNode<SendMessageMutation, SendMessageMutationVariables> = gql`
  mutation SendMessage($input: SendMessageInput!) {
    sendMessage(input: $input) {
      ...MessageFields
    }
  }
  ${MESSAGE_FIELDS}
`;

/** Edit a message (own messages only). */
export const EDIT_MESSAGE: TypedDocumentNode<EditMessageMutation, EditMessageMutationVariables> = gql`
  mutation EditMessage($id: ID!, $input: EditMessageInput!) {
    editMessage(id: $id, input: $input) {
      ...MessageFields
    }
  }
  ${MESSAGE_FIELDS}
`;

/** Soft-delete a message. */
export const DELETE_MESSAGE: TypedDocumentNode<DeleteMessageMutation, DeleteMessageMutationVariables> = gql`
  mutation DeleteMessage($id: ID!) {
    deleteMessage(id: $id)
  }
`;

/** Mark messages as read up to a given message. */
export const MARK_MESSAGES_READ: TypedDocumentNode<MarkMessagesReadMutation, MarkMessagesReadMutationVariables> = gql`
  mutation MarkMessagesRead($input: MarkReadInput!) {
    markMessagesRead(input: $input)
  }
`;

/** Request a presigned URL for media upload. */
export const REQUEST_MEDIA_UPLOAD: TypedDocumentNode<RequestMediaUploadMutation, RequestMediaUploadMutationVariables> = gql`
  mutation RequestMediaUpload($input: RequestMediaUploadInput!) {
    requestMediaUpload(input: $input) {
      uploadUrl
      storageKey
      expiresAt
    }
  }
`;

/** Pin a message in a channel. */
export const PIN_MESSAGE: TypedDocumentNode<PinMessageMutation, PinMessageMutationVariables> = gql`
  mutation PinMessage($channelId: ID!, $messageId: ID!) {
    pinMessage(channelId: $channelId, messageId: $messageId) {
      id
      channelId
      pinnedBy
      pinnedAt
      message {
        ...MessageFields
      }
    }
  }
  ${MESSAGE_FIELDS}
`;

/** Unpin a message. */
export const UNPIN_MESSAGE: TypedDocumentNode<UnpinMessageMutation, UnpinMessageMutationVariables> = gql`
  mutation UnpinMessage($channelId: ID!, $messageId: ID!) {
    unpinMessage(channelId: $channelId, messageId: $messageId)
  }
`;

/** Add a reaction to a message. */
export const ADD_REACTION: TypedDocumentNode<AddReactionMutation, AddReactionMutationVariables> = gql`
  mutation AddReaction($messageId: ID!, $emoji: String!) {
    addReaction(messageId: $messageId, emoji: $emoji)
  }
`;

/** Remove a reaction from a message. */
export const REMOVE_REACTION: TypedDocumentNode<RemoveReactionMutation, RemoveReactionMutationVariables> = gql`
  mutation RemoveReaction($messageId: ID!, $emoji: String!) {
    removeReaction(messageId: $messageId, emoji: $emoji)
  }
`;

/** Forward a message to another channel. */
export const FORWARD_MESSAGE: TypedDocumentNode<ForwardMessageMutation, ForwardMessageMutationVariables> = gql`
  mutation ForwardMessage($sourceMessageId: ID!, $sourceMessageCreatedAt: DateTime!, $targetChannelId: ID!) {
    forwardMessage(sourceMessageId: $sourceMessageId, sourceMessageCreatedAt: $sourceMessageCreatedAt, targetChannelId: $targetChannelId) {
      ...MessageFields
    }
  }
  ${MESSAGE_FIELDS}
`;

/**
 * Confirm a proposed AI action (MOB-HIGH-001, human-in-the-loop). The argument
 * is the ID of the AI MESSAGE carrying the proposal metadata; messaging-service
 * verifies channel membership, then ai-service executes the PERSISTED proposal
 * row keyed by metadata.actionId — never client-echoed params.
 */
export const MOBILE_CONFIRM_AI_ACTION: TypedDocumentNode<
  MobileConfirmAiActionMutation,
  MobileConfirmAiActionMutationVariables
> = gql`
  mutation MobileConfirmAiAction($actionId: ID!) {
    confirmAiAction(actionId: $actionId)
  }
`;

/**
 * Weekly aggregate sentiment trends for a channel (TENANT_ADMIN only,
 * backend-enforced). MOB-MEDIUM-003: replaces the hardcoded 'neutral' badge in
 * ChannelSettingsPage with the real `message_analyses` aggregates. Sentiment is
 * never exposed per-message — only these weekly rollups.
 */
export const MOBILE_SENTIMENT_TRENDS: TypedDocumentNode<
  MobileSentimentTrendsQuery,
  MobileSentimentTrendsQueryVariables
> = gql`
  query MobileSentimentTrends($input: SentimentTrendsInput!) {
    sentimentTrends(input: $input) {
      channelId
      weekStart
      avgScore
      messageCount
      trend
    }
  }
`;
