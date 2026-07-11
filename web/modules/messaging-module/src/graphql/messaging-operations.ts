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

export const SEND_MESSAGE_MUTATION = `
  mutation SendMessage($input: SendMessageInput!) {
    sendMessage(input: $input) { ${MESSAGE_FIELDS} }
  }
`;
