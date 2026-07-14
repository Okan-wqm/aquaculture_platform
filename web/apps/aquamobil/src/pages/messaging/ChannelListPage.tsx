/**
 * ChannelListPage -- WhatsApp-style channel/conversation list.
 *
 * WHY this design: Field workers need instant access to team communication
 * without leaving the mobile app. The channel list surfaces unread counts,
 * last message previews, and timestamps so workers can triage conversations
 * at a glance. Pull-to-refresh and search-as-you-type follow platform
 * conventions for a native-feeling experience.
 *
 * Channels are sorted by last message timestamp DESC so the most active
 * conversations bubble to the top. DM channels display the other user's
 * computed name (not "Direct Message") for clarity.
 */

import { clsx } from 'clsx';
import {
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { ChannelAvatar } from '@/components/messaging/ChannelAvatar';
import { VirtualList } from '@/components/VirtualList';
import { useAuth } from '@/hooks/useAuth';
import { useChannels } from '@/hooks/useChannels';
import { useMessageSocket } from '@/hooks/useMessageSocket';
import type { Channel } from '@/types/messaging';
import { formatRelativeTime, getUserDisplayName } from '@/utils/messaging-helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the display name for a channel. For direct channels, derive from
 * the other member's user details instead of using channel.name.
 */
function getChannelDisplayName(channel: Channel, currentUserId: string | undefined): string {
  if (channel.type === 'direct' && channel.members) {
    const otherMember = channel.members.find((m) => m.userId !== currentUserId);
    if (otherMember?.user) {
      return getUserDisplayName(otherMember.user);
    }
  }
  return channel.name ?? 'Unnamed Channel';
}

/**
 * Determine if the other user in a DM channel is online.
 */
function isOtherUserOnline(channel: Channel, currentUserId: string | undefined): boolean {
  if (channel.type !== 'direct' || !channel.members) return false;
  const otherMember = channel.members.find((m) => m.userId !== currentUserId);
  return otherMember?.user?.isOnline ?? false;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Skeleton loader for a single channel row while data is fetching. */
function ChannelSkeleton(): ReactElement {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="w-12 h-12 rounded-full skeleton flex-shrink-0" />
      <div className="flex-1 min-w-0 space-y-2">
        <div className="h-4 w-32 rounded skeleton" />
        <div className="h-3 w-48 rounded skeleton" />
      </div>
      <div className="h-3 w-8 rounded skeleton" />
    </div>
  );
}

/** A single channel row in the list. */
function ChannelRow({
  channel,
  currentUserId,
  onPress,
}: {
  channel: Channel;
  currentUserId: string | undefined;
  onPress: () => void;
}): ReactElement {
  const displayName = getChannelDisplayName(channel, currentUserId);
  const online = isOtherUserOnline(channel, currentUserId);
  const hasUnread = (channel.unreadCount ?? 0) > 0;

  // Compute last message preview
  const lastMsgContent = channel.lastMessage?.content ?? null;
  const lastMsgSender = channel.lastMessage?.sender
    ? getUserDisplayName(channel.lastMessage.sender)
    : null;
  const lastMsgTime = channel.lastMessage?.createdAt ?? null;

  // Map channel type to ChannelAvatar type prop
  const avatarType = channel.type === 'direct' ? 'dm' : channel.type === 'ai' ? 'ai' : 'group';

  return (
    <button
      onClick={onPress}
      className="w-full flex items-center gap-3 px-4 py-3 touch-feedback transition-all active:bg-gray-50 dark:active:bg-gray-800/50"
    >
      <ChannelAvatar
        type={avatarType}
        name={displayName}
        imageUrl={channel.avatarUrl ?? undefined}
        isOnline={online}
        size="lg"
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <h3
            className={clsx(
              'text-sm truncate',
              hasUnread
                ? 'font-bold text-gray-900 dark:text-white'
                : 'font-medium text-gray-700 dark:text-gray-300',
            )}
          >
            {displayName}
          </h3>
          {lastMsgTime && (
            <span
              className={clsx(
                'text-[11px] flex-shrink-0',
                hasUnread
                  ? 'font-semibold text-ocean-600 dark:text-ocean-400'
                  : 'text-gray-400 dark:text-gray-500',
              )}
            >
              {formatRelativeTime(lastMsgTime)}
            </span>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 mt-0.5">
          <p
            className={clsx(
              'text-xs truncate flex-1',
              hasUnread
                ? 'font-medium text-gray-600 dark:text-gray-300'
                : 'text-gray-400 dark:text-gray-500',
            )}
          >
            {lastMsgContent
              ? channel.type === 'group' && lastMsgSender
                ? `${lastMsgSender}: ${lastMsgContent}`
                : lastMsgContent
              : 'No messages yet'}
          </p>

          {hasUnread && (
            <span className="bg-ocean-500 text-white text-[10px] font-bold rounded-full min-w-[20px] h-[20px] flex items-center justify-center px-1 flex-shrink-0">
              {(channel.unreadCount ?? 0) > 99 ? '99+' : channel.unreadCount}
            </span>
          )}

          {channel.type === 'group' && !hasUnread && (
            <span className="text-[10px] text-gray-400 dark:text-gray-500 flex-shrink-0">
              {channel.memberCount ?? 0}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

/**
 * ChannelListPage displays all messaging channels the current user belongs to,
 * sorted by most recent activity. Supports search filtering, pull-to-refresh,
 * and a FAB for creating new conversations.
 */
export function ChannelListPage(): ReactElement {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const { channels, isLoading, error, refetch } = useChannels();
  const { isConnected, resolveNotificationRef } = useMessageSocket();

  const [searchQuery, setSearchQuery] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const resolvingNotificationRef = useRef<string | null>(null);

  useEffect(() => {
    const notificationRef = searchParams.get('notificationRef');
    if (
      !notificationRef ||
      !isConnected ||
      resolvingNotificationRef.current === notificationRef
    ) {
      return;
    }

    resolvingNotificationRef.current = notificationRef;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('notificationRef');

    void resolveNotificationRef(notificationRef).then((resolved) => {
      setSearchParams(nextParams, { replace: true });
      if (resolved) {
        navigate(`/messages/${resolved.channelId}`, { replace: true });
      }
    });
  }, [isConnected, navigate, resolveNotificationRef, searchParams, setSearchParams]);

  // Filter channels by search query
  const filteredChannels = useMemo(() => {
    if (!searchQuery.trim()) return channels;

    const query = searchQuery.toLowerCase();
    return channels.filter((ch) => {
      const displayName = getChannelDisplayName(ch, user?.id);
      return displayName.toLowerCase().includes(query);
    });
  }, [channels, searchQuery, user?.id]);

  // Sort by last message timestamp DESC
  const sortedChannels = useMemo(() => {
    return [...filteredChannels].sort((a, b) => {
      const aTime = a.lastMessage
        ? new Date(a.lastMessage.createdAt).getTime()
        : 0;
      const bTime = b.lastMessage
        ? new Date(b.lastMessage.createdAt).getTime()
        : 0;
      return bTime - aTime;
    });
  }, [filteredChannels]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await refetch();
    setIsRefreshing(false);
  }, [refetch]);

  const handleOpenSearch = useCallback(() => {
    setIsSearchOpen(true);
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, []);

  const handleCloseSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchQuery('');
  }, []);

  const handleChannelPress = useCallback(
    (channelId: string) => {
      navigate(`/messages/${channelId}`);
    },
    [navigate],
  );

  const handleNewChat = useCallback(() => {
    navigate('/messages/new');
  }, [navigate]);

  const loading = isLoading;
  const errorMsg = error ? (error instanceof Error ? error.message : 'Failed to load channels') : null;

  return (
    // MOB-MEDIUM-012: bounded flex column (matching NotificationsPage) so the
    // channel list virtualizes inside its own scroll region instead of paging
    // the whole document — the header stays put while a large membership scrolls.
    <div className="h-screen overflow-hidden bg-gray-50 dark:bg-gray-950 flex flex-col">
      {/* Header */}
      <div className="bg-gradient-to-r from-ocean-600 to-ocean-500 text-white">
        <div className="px-4 py-4 pt-safe-top">
          {isSearchOpen ? (
            <div className="flex items-center gap-3">
              <button
                onClick={handleCloseSearch}
                className="min-w-[48px] min-h-[48px] p-3 -ml-2 rounded-xl hover:bg-white/10 touch-feedback flex items-center justify-center"
              >
                <X size={22} />
              </button>
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search conversations..."
                className="flex-1 bg-white/20 text-white placeholder-white/60 rounded-xl px-4 py-2.5 text-sm outline-none focus:bg-white/30 transition-colors"
              />
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <MessageSquare size={22} />
                <h1 className="text-lg font-bold">Messages</h1>
              </div>
              <button
                onClick={handleOpenSearch}
                className="min-w-[48px] min-h-[48px] p-3 rounded-xl hover:bg-white/10 touch-feedback flex items-center justify-center"
              >
                <Search size={20} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Pull-to-refresh button */}
      <div className="px-4 pt-3 flex justify-end">
        <button
          onClick={() => {
            void handleRefresh();
          }}
          disabled={isRefreshing}
          className="flex items-center gap-1.5 text-xs text-ocean-500 font-medium touch-feedback"
        >
          <RefreshCw
            size={14}
            className={clsx(isRefreshing && 'animate-spin')}
          />
          {isRefreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* Channel list */}
      <div className="pt-1 flex-1 min-h-0 flex flex-col">
        {loading ? (
          <div className="space-y-1">
            {[1, 2, 3, 4, 5].map((i) => (
              <ChannelSkeleton key={i} />
            ))}
          </div>
        ) : errorMsg ? (
          <div className="text-center py-12 px-4">
            <MessageSquare
              size={48}
              className="mx-auto mb-3 text-gray-300 opacity-60"
            />
            <p className="font-medium text-gray-600 dark:text-gray-300">
              Could not load messages
            </p>
            <p className="text-sm text-gray-400 mt-1">{errorMsg}</p>
            <button
              onClick={() => {
                void handleRefresh();
              }}
              className="mt-4 inline-flex items-center gap-2 px-4 py-2.5 bg-ocean-500 text-white rounded-xl text-sm font-semibold touch-feedback"
            >
              <RefreshCw size={16} />
              Retry
            </button>
          </div>
        ) : sortedChannels.length === 0 ? (
          <div className="text-center py-12 px-4">
            <MessageSquare
              size={48}
              className="mx-auto mb-3 text-gray-300 dark:text-gray-600 opacity-30"
            />
            <p className="font-medium text-gray-500 dark:text-gray-400">
              {searchQuery ? 'No conversations found' : 'No messages yet'}
            </p>
            <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
              {searchQuery
                ? 'Try a different search term'
                : 'Start a conversation with your team'}
            </p>
            {!searchQuery && (
              <button
                onClick={handleNewChat}
                className="mt-4 inline-flex items-center gap-2 px-4 py-2.5 bg-ocean-500 text-white rounded-xl text-sm font-semibold touch-feedback"
              >
                <Plus size={16} />
                New Message
              </button>
            )}
          </div>
        ) : (
          <VirtualList
            items={sortedChannels}
            getKey={(channel) => channel.id}
            estimateSize={() => 72}
            className="flex-1 min-h-0"
            renderItem={(channel) => (
              <div className="border-b border-gray-100 dark:border-gray-800/50">
                <ChannelRow
                  channel={channel}
                  currentUserId={user?.id}
                  onPress={() => handleChannelPress(channel.id)}
                />
              </div>
            )}
          />
        )}
      </div>

      {/* FAB -- New chat button (bottom-right, above tab bar) */}
      {!loading && !errorMsg && (
        <button
          onClick={handleNewChat}
          className="fixed bottom-24 right-5 w-14 h-14 bg-gradient-to-br from-ocean-500 to-ocean-600 text-white rounded-full shadow-lg shadow-ocean-500/30 flex items-center justify-center touch-feedback transition-transform active:scale-95 z-40"
          aria-label="New message"
        >
          <Plus size={24} />
        </button>
      )}

      {/* Bottom spacer for tab bar */}
      <div className="h-24" />
    </div>
  );
}
