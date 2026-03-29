// ============================================================================
// Messaging GraphQL Operations — ADR-012
// ============================================================================
// All queries and mutations for the in-app messaging feature.
// Matches the messaging-service GraphQL schema (ADR-012 section 6.2).
// Note: tenantId/userId come from @Tenant() and @CurrentUser() backend
// decorators, NOT from GraphQL variables. They are extracted from JWT.

// --- Message fragment for reuse across queries ---
const MESSAGE_FIELDS = `
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
    email
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
`;

const CHANNEL_FIELDS = `
  id
  type
  name
  description
  avatarUrl
  createdBy
  isArchived
  createdAt
  updatedAt
  unreadCount
  memberCount
  lastMessage {
    ${MESSAGE_FIELDS}
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
      email
      profileImageUrl
      isOnline
    }
  }
`;

// ============================================================================
// Queries
// ============================================================================

/** List channels for the current user, sorted by last message timestamp. */
export const MY_CHANNELS = `
  query MyChannels($limit: Int, $offset: Int) {
    myChannels(limit: $limit, offset: $offset) {
      items {
        ${CHANNEL_FIELDS}
      }
      total
    }
  }
`;

/** Get a single channel by ID (must be a member). */
export const GET_CHANNEL = `
  query GetChannel($id: String!) {
    channel(id: $id) {
      ${CHANNEL_FIELDS}
    }
  }
`;

/** Get paginated messages in a channel (cursor-based, newest first). */
export const GET_MESSAGES = `
  query GetMessages($channelId: String!, $filter: MessageFilterInput) {
    messages(channelId: $channelId, filter: $filter) {
      items {
        ${MESSAGE_FIELDS}
      }
      hasMore
      cursor
    }
  }
`;

/** Get messages since a timestamp for a single channel (offline sync). */
export const MESSAGES_SINCE = `
  query MessagesSince($channelId: String!, $since: DateTime!) {
    messagesSince(channelId: $channelId, since: $since) {
      ${MESSAGE_FIELDS}
    }
  }
`;

/** Bulk offline sync — all new messages across all channels since timestamp. */
export const ALL_MESSAGES_SINCE = `
  query AllMessagesSince($since: DateTime!, $limit: Int, $syncToken: String) {
    allMessagesSince(since: $since, limit: $limit, syncToken: $syncToken) {
      items {
        ${MESSAGE_FIELDS}
      }
      hasMore
      syncToken
    }
  }
`;

/** Get total unread message count across all channels. */
export const TOTAL_UNREAD_MESSAGE_COUNT = `
  query TotalUnreadMessageCount {
    totalUnreadMessageCount
  }
`;

/** Full-text search across messages. */
export const SEARCH_MESSAGES = `
  query SearchMessages($input: SearchMessagesInput!) {
    searchMessages(input: $input) {
      ${MESSAGE_FIELDS}
    }
  }
`;

/** Get pinned messages in a channel. */
export const GET_PINNED_MESSAGES = `
  query GetPinnedMessages($channelId: String!) {
    pinnedMessages(channelId: $channelId) {
      id
      channelId
      pinnedBy
      pinnedAt
      message {
        ${MESSAGE_FIELDS}
      }
    }
  }
`;

/** Get online/offline status for a list of user IDs. */
export const USER_PRESENCE = `
  query UserPresence($userIds: [String!]!) {
    userPresence(userIds: $userIds) {
      id
      firstName
      lastName
      email
      profileImageUrl
      isOnline
    }
  }
`;

/** Get or create a DM channel with another user. */
export const DIRECT_CHANNEL = `
  query DirectChannel($userId: String!) {
    directChannel(userId: $userId) {
      ${CHANNEL_FIELDS}
    }
  }
`;

// ============================================================================
// Mutations
// ============================================================================

/** Create a new group channel. */
export const CREATE_CHANNEL = `
  mutation CreateChannel($input: CreateChannelInput!) {
    createChannel(input: $input) {
      ${CHANNEL_FIELDS}
    }
  }
`;

/** Update channel name, description, or avatar. */
export const UPDATE_CHANNEL = `
  mutation UpdateChannel($id: String!, $input: UpdateChannelInput!) {
    updateChannel(id: $id, input: $input) {
      ${CHANNEL_FIELDS}
    }
  }
`;

/** Archive (soft-delete) a channel. */
export const ARCHIVE_CHANNEL = `
  mutation ArchiveChannel($id: String!) {
    archiveChannel(id: $id)
  }
`;

/** Add a member to a channel. */
export const ADD_CHANNEL_MEMBER = `
  mutation AddChannelMember($channelId: String!, $userId: String!, $role: ChannelMemberRole) {
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
        email
        profileImageUrl
        isOnline
      }
    }
  }
`;

/** Remove a member from a channel (or leave). */
export const REMOVE_CHANNEL_MEMBER = `
  mutation RemoveChannelMember($channelId: String!, $userId: String!) {
    removeChannelMember(channelId: $channelId, userId: $userId)
  }
`;

/** Update notification preference for a channel. */
export const UPDATE_NOTIFICATION_PREFERENCE = `
  mutation UpdateNotificationPreference($channelId: String!, $preference: NotificationPreference!) {
    updateNotificationPreference(channelId: $channelId, preference: $preference) {
      id
      notificationPreference
    }
  }
`;

/** Send a message to a channel. */
export const SEND_MESSAGE = `
  mutation SendMessage($input: SendMessageInput!) {
    sendMessage(input: $input) {
      ${MESSAGE_FIELDS}
    }
  }
`;

/** Edit a message (own messages only). */
export const EDIT_MESSAGE = `
  mutation EditMessage($id: String!, $input: EditMessageInput!) {
    editMessage(id: $id, input: $input) {
      ${MESSAGE_FIELDS}
    }
  }
`;

/** Soft-delete a message. */
export const DELETE_MESSAGE = `
  mutation DeleteMessage($id: String!) {
    deleteMessage(id: $id)
  }
`;

/** Mark messages as read up to a given message. */
export const MARK_MESSAGES_READ = `
  mutation MarkMessagesRead($input: MarkReadInput!) {
    markMessagesRead(input: $input)
  }
`;

/** Request a presigned URL for media upload. */
export const REQUEST_MEDIA_UPLOAD = `
  mutation RequestMediaUpload($input: RequestMediaUploadInput!) {
    requestMediaUpload(input: $input) {
      uploadUrl
      storageKey
      expiresAt
    }
  }
`;

/** Pin a message in a channel. */
export const PIN_MESSAGE = `
  mutation PinMessage($channelId: String!, $messageId: String!) {
    pinMessage(channelId: $channelId, messageId: $messageId) {
      id
      channelId
      pinnedBy
      pinnedAt
      message {
        ${MESSAGE_FIELDS}
      }
    }
  }
`;

/** Unpin a message. */
export const UNPIN_MESSAGE = `
  mutation UnpinMessage($channelId: String!, $messageId: String!) {
    unpinMessage(channelId: $channelId, messageId: $messageId)
  }
`;

/** Add a reaction to a message. */
export const ADD_REACTION = `
  mutation AddReaction($messageId: String!, $emoji: String!) {
    addReaction(messageId: $messageId, emoji: $emoji)
  }
`;

/** Remove a reaction from a message. */
export const REMOVE_REACTION = `
  mutation RemoveReaction($messageId: String!, $emoji: String!) {
    removeReaction(messageId: $messageId, emoji: $emoji)
  }
`;
