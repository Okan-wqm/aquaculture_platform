import { createTenantQueryKey } from './tenant-query-keys';

export const messagingQueryKeys = {
  channels: (tenantId: string | null | undefined) =>
    createTenantQueryKey(tenantId, 'messaging', 'channels'),
  channelPage: (
    tenantId: string | null | undefined,
    offset: number | string | null | undefined,
  ) => createTenantQueryKey(tenantId, 'messaging', 'channels', offset),
  channel: (
    tenantId: string | null | undefined,
    channelId: string | null | undefined,
  ) => createTenantQueryKey(tenantId, 'messaging', 'channel', channelId),
  channelMembers: (
    tenantId: string | null | undefined,
    channelId: string | null | undefined,
  ) => createTenantQueryKey(tenantId, 'messaging', 'channelMembers', channelId),
  tenantUsers: (tenantId: string | null | undefined) =>
    createTenantQueryKey(tenantId, 'messaging', 'tenantUsers'),
  messages: (
    tenantId: string | null | undefined,
    channelId: string | null | undefined,
  ) => createTenantQueryKey(tenantId, 'messaging', 'messages', channelId),
  allMessages: (tenantId: string | null | undefined) =>
    createTenantQueryKey(tenantId, 'messaging', 'messages'),
  unreadCount: (tenantId: string | null | undefined) =>
    createTenantQueryKey(tenantId, 'messaging', 'unreadCount'),
  aiConsent: (tenantId: string | null | undefined) =>
    createTenantQueryKey(tenantId, 'messaging', 'ai-consent'),
  aiPersonas: (tenantId: string | null | undefined) =>
    createTenantQueryKey(tenantId, 'messaging', 'aiPersonas'),
} as const;
