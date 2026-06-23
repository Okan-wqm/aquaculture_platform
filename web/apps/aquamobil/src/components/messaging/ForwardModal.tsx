/**
 * @module ForwardModal
 * @description Modal for forwarding a message to another channel.
 * Shows a list of the user's channels with search/filter, a preview
 * of the message being forwarded, and a confirm action.
 *
 * WHY modal over bottom sheet: Forwarding requires selecting from a
 * potentially long channel list. A full modal provides more space for
 * search and scrolling than a bottom sheet.
 *
 * @see ADR-012 section 5.5 (Message Forwarding)
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import type { LucideIcon } from 'lucide-react';
import { X, Search, Forward, Hash, Users, MessageCircle } from 'lucide-react';
import { useState, useCallback, useMemo, type ReactElement } from 'react';

import { FORWARD_MESSAGE } from '@/graphql/messaging-operations';
import { useAuth } from '@/hooks/useAuth';
import { useChannels } from '@/hooks/useChannels';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { Channel, Message } from '@/types/messaging';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ForwardModalProps {
  /** The message being forwarded. */
  message: Message;
  /** Callback to close the modal. */
  onClose: () => void;
  /** Whether the modal is visible. */
  visible: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getChannelIcon(type: Channel['type']): LucideIcon {
  switch (type) {
    case 'direct':
      return MessageCircle;
    case 'group':
      return Users;
    default:
      return Hash;
  }
}

function getChannelDisplayName(channel: Channel): string {
  if (channel.name) return channel.name;
  // For DM channels, show the other member's name
  if (channel.type === 'direct' && channel.members?.length) {
    const other = channel.members[0];
    if (other?.user) {
      const parts = [other.user.firstName, other.user.lastName].filter(Boolean);
      if (parts.length > 0) return parts.join(' ');
      if (other.user.email) return other.user.email.split('@')[0] ?? 'DM';
    }
  }
  return 'Unnamed Channel';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * ForwardModal -- fullscreen modal for selecting a target channel to forward to.
 */
export function ForwardModal({
  message,
  onClose,
  visible,
}: ForwardModalProps): ReactElement | null {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { channels, isLoading: channelsLoading } = useChannels();

  // Filter channels — exclude the source channel
  const filteredChannels = useMemo(() => {
    if (!channels) return [];
    const lowerQuery = searchQuery.toLowerCase();
    return channels.filter((ch) => {
      // Exclude the channel this message is already in
      if (ch.id === message.channelId) return false;
      // Exclude archived channels
      if (ch.isArchived) return false;
      // Filter by search query
      if (!lowerQuery) return true;
      const name = getChannelDisplayName(ch).toLowerCase();
      return name.includes(lowerQuery);
    });
  }, [channels, searchQuery, message.channelId]);

  const { tenantId } = useAuth();

  // Forward mutation
  const forwardMutation = useMutation({
    mutationFn: async (targetChannelId: string) => {
      const result = await graphqlRequest<{ forwardMessage: Message }>(
        FORWARD_MESSAGE,
        {
          sourceMessageId: message.id,
          sourceMessageCreatedAt: message.createdAt,
          targetChannelId,
        },
      );
      return result.forwardMessage;
    },
    onSuccess: () => {
      // Invalidate message queries for the target channel. invalidateQueries
      // returns a Promise; we intentionally fire-and-forget the refetch here, so
      // mark it void to satisfy no-floating-promises without blocking onClose.
      void queryClient.invalidateQueries({ queryKey: createTenantQueryKey(tenantId, 'messaging', 'messages') });
      void queryClient.invalidateQueries({ queryKey: createTenantQueryKey(tenantId, 'messaging', 'channels') });
      onClose();
    },
  });

  /** Handle channel selection. */
  const handleSelect = useCallback((channelId: string) => {
    setSelectedChannelId(channelId);
  }, []);

  /** Handle forward confirmation. */
  const handleForward = useCallback(() => {
    if (!selectedChannelId) return;
    forwardMutation.mutate(selectedChannelId);
  }, [selectedChannelId, forwardMutation]);

  if (!visible) return null;

  const isForwarding = forwardMutation.isPending;
  const preview = message.content
    ? message.content.length > 80
      ? `${message.content.slice(0, 80)}...`
      : message.content
    : message.contentType === 'VOICE'
      ? 'Voice note'
      : message.contentType === 'IMAGE'
        ? 'Image'
        : 'File';

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-gray-900">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800">
        <button
          onClick={onClose}
          disabled={isForwarding}
          className="min-w-[48px] min-h-[48px] flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 touch-feedback"
          aria-label="Close"
        >
          <X size={22} className="text-gray-600 dark:text-gray-300" />
        </button>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Forward Message
          </h2>
        </div>
        <button
          onClick={handleForward}
          disabled={!selectedChannelId || isForwarding}
          className={clsx(
            'min-w-[48px] min-h-[48px] flex items-center justify-center rounded-full transition-all touch-feedback',
            selectedChannelId && !isForwarding
              ? 'bg-ocean-600 hover:bg-ocean-700'
              : 'bg-ocean-600/50 opacity-50 cursor-not-allowed',
          )}
          aria-label="Forward"
        >
          <Forward size={20} className="text-white" />
        </button>
      </div>

      {/* Message preview */}
      <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-100 dark:border-gray-800">
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">
          Forwarding:
        </p>
        <p className="text-sm text-gray-700 dark:text-gray-300 truncate">
          {preview}
        </p>
      </div>

      {/* Search */}
      <div className="px-4 py-2">
        <div className="relative">
          <Search
            size={18}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search channels..."
            className={clsx(
              'w-full pl-10 pr-4 py-2.5 rounded-xl text-sm',
              'bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700',
              'text-gray-900 dark:text-gray-100 placeholder-gray-400',
              'focus:outline-none focus:ring-2 focus:ring-ocean-500/40 focus:border-ocean-500',
            )}
          />
        </div>
      </div>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto">
        {channelsLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-6 h-6 border-2 border-ocean-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : filteredChannels.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <p className="text-sm text-gray-400">No channels found</p>
          </div>
        ) : (
          filteredChannels.map((channel) => {
            const Icon = getChannelIcon(channel.type);
            const isSelected = channel.id === selectedChannelId;

            return (
              <button
                key={channel.id}
                onClick={() => handleSelect(channel.id)}
                disabled={isForwarding}
                className={clsx(
                  'flex items-center gap-3 w-full px-4 py-3 min-h-[56px] text-left touch-feedback transition-colors',
                  isSelected
                    ? 'bg-ocean-50 dark:bg-ocean-900/20 border-l-2 border-ocean-500'
                    : 'hover:bg-gray-50 dark:hover:bg-gray-800 border-l-2 border-transparent',
                )}
              >
                <div
                  className={clsx(
                    'w-10 h-10 rounded-full flex items-center justify-center shrink-0',
                    isSelected
                      ? 'bg-ocean-100 dark:bg-ocean-900/40'
                      : 'bg-gray-100 dark:bg-gray-800',
                  )}
                >
                  <Icon
                    size={18}
                    className={
                      isSelected
                        ? 'text-ocean-600 dark:text-ocean-400'
                        : 'text-gray-500 dark:text-gray-400'
                    }
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p
                    className={clsx(
                      'text-sm font-medium truncate',
                      isSelected
                        ? 'text-ocean-700 dark:text-ocean-300'
                        : 'text-gray-900 dark:text-gray-100',
                    )}
                  >
                    {getChannelDisplayName(channel)}
                  </p>
                  <p className="text-[10px] text-gray-400 dark:text-gray-500">
                    {channel.memberCount ?? 0} members
                  </p>
                </div>
                {isSelected && (
                  <div className="w-5 h-5 rounded-full bg-ocean-600 flex items-center justify-center shrink-0">
                    <div className="w-2 h-2 rounded-full bg-white" />
                  </div>
                )}
              </button>
            );
          })
        )}
      </div>

      {/* Error display */}
      {forwardMutation.error && (
        <div className="px-4 py-2 bg-red-50 dark:bg-red-900/20 border-t border-red-100 dark:border-red-800">
          <p className="text-xs text-red-600 dark:text-red-400">
            {forwardMutation.error instanceof Error
              ? forwardMutation.error.message
              : 'Failed to forward message'}
          </p>
        </div>
      )}
    </div>
  );
}
