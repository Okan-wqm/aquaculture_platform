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
 * name (not "Direct Message") for clarity.
 */

import { useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MessageSquare,
  Search,
  Plus,
  Users,
  RefreshCw,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';

// ---------------------------------------------------------------------------
// Types — messaging domain models used by this page
// ---------------------------------------------------------------------------

/** Represents a messaging channel (DM or group). */
interface Channel {
  id: string;
  name: string;
  type: 'DM' | 'GROUP';
  avatarUrl: string | null;
  memberCount: number;
  lastMessage: {
    content: string;
    senderName: string;
    sentAt: string;
  } | null;
  unreadCount: number;
  /** For DM channels: the other participant's display name. */
  otherUserName: string | null;
  /** For DM channels: online status of the other participant. */
  isOtherUserOnline: boolean;
}

// ---------------------------------------------------------------------------
// TODO: Replace with real hook once messaging backend is integrated
// import { useChannels } from '@/hooks/useChannels';
// ---------------------------------------------------------------------------

/** Temporary hook stub — returns empty state until backend is wired up. */
function useChannels(): {
  channels: Channel[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
} {
  return {
    channels: [],
    loading: false,
    error: null,
    refetch: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a timestamp into a short relative label for the channel list.
 * Shows "Just now", "5m", "2h", "Yesterday", or a short date.
 */
function formatChannelTime(isoString: string): string {
  const now = Date.now();
  const date = new Date(isoString).getTime();
  if (isNaN(date)) return '';

  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHour = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHour < 24) return `${diffHour}h`;
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay}d`;

  return new Date(isoString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Get initials from a name string for the avatar fallback.
 * "John Doe" => "JD", "Admin" => "A".
 */
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return '?';
  const first = parts[0]?.charAt(0).toUpperCase() ?? '';
  const last =
    parts.length > 1
      ? (parts[parts.length - 1]?.charAt(0).toUpperCase() ?? '')
      : '';
  return first + last;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Skeleton loader for a single channel row while data is fetching. */
function ChannelSkeleton() {
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

/** Avatar component for a channel — shows image or initials fallback. */
function ChannelAvatar({
  channel,
}: {
  channel: Channel;
}) {
  const displayName =
    channel.type === 'DM' && channel.otherUserName
      ? channel.otherUserName
      : channel.name;
  const initials = getInitials(displayName);
  const isOnline = channel.type === 'DM' && channel.isOtherUserOnline;

  if (channel.avatarUrl) {
    return (
      <div className="relative flex-shrink-0">
        <img
          src={channel.avatarUrl}
          alt={displayName}
          className="w-12 h-12 rounded-full object-cover"
        />
        {isOnline && (
          <div className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-green-500 border-2 border-white dark:border-gray-900 rounded-full" />
        )}
      </div>
    );
  }

  return (
    <div className="relative flex-shrink-0">
      <div
        className={clsx(
          'w-12 h-12 rounded-full flex items-center justify-center text-sm font-bold',
          channel.type === 'DM'
            ? 'bg-gradient-to-br from-ocean-400 to-ocean-600 text-white'
            : 'bg-gradient-to-br from-purple-400 to-purple-600 text-white',
        )}
      >
        {channel.type === 'GROUP' ? (
          <Users size={20} />
        ) : (
          initials
        )}
      </div>
      {isOnline && (
        <div className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-green-500 border-2 border-white dark:border-gray-900 rounded-full" />
      )}
    </div>
  );
}

/** A single channel row in the list. */
function ChannelRow({
  channel,
  onPress,
}: {
  channel: Channel;
  onPress: () => void;
}) {
  const displayName =
    channel.type === 'DM' && channel.otherUserName
      ? channel.otherUserName
      : channel.name;

  const hasUnread = channel.unreadCount > 0;

  return (
    <button
      onClick={onPress}
      className="w-full flex items-center gap-3 px-4 py-3 touch-feedback transition-all active:bg-gray-50 dark:active:bg-gray-800/50"
    >
      <ChannelAvatar channel={channel} />

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
          {channel.lastMessage && (
            <span
              className={clsx(
                'text-[11px] flex-shrink-0',
                hasUnread
                  ? 'font-semibold text-ocean-600 dark:text-ocean-400'
                  : 'text-gray-400 dark:text-gray-500',
              )}
            >
              {formatChannelTime(channel.lastMessage.sentAt)}
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
            {channel.lastMessage
              ? channel.type === 'GROUP'
                ? `${channel.lastMessage.senderName}: ${channel.lastMessage.content}`
                : channel.lastMessage.content
              : 'No messages yet'}
          </p>

          {hasUnread && (
            <span className="bg-ocean-500 text-white text-[10px] font-bold rounded-full min-w-[20px] h-[20px] flex items-center justify-center px-1 flex-shrink-0">
              {channel.unreadCount > 99 ? '99+' : channel.unreadCount}
            </span>
          )}

          {channel.type === 'GROUP' && !hasUnread && (
            <span className="text-[10px] text-gray-400 dark:text-gray-500 flex-shrink-0">
              {channel.memberCount}
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
export function ChannelListPage() {
  const navigate = useNavigate();
  const { channels, loading, error, refetch } = useChannels();

  const [searchQuery, setSearchQuery] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Filter channels by search query
  const filteredChannels = useMemo(() => {
    if (!searchQuery.trim()) return channels;

    const query = searchQuery.toLowerCase();
    return channels.filter((ch) => {
      const displayName =
        ch.type === 'DM' && ch.otherUserName
          ? ch.otherUserName
          : ch.name;
      return displayName.toLowerCase().includes(query);
    });
  }, [channels, searchQuery]);

  // Sort by last message timestamp DESC
  const sortedChannels = useMemo(() => {
    return [...filteredChannels].sort((a, b) => {
      const aTime = a.lastMessage
        ? new Date(a.lastMessage.sentAt).getTime()
        : 0;
      const bTime = b.lastMessage
        ? new Date(b.lastMessage.sentAt).getTime()
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
    // Focus the input after the next paint
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

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <div className="bg-gradient-to-r from-ocean-600 to-ocean-500 text-white">
        <div className="px-4 py-4 pt-safe-top">
          {isSearchOpen ? (
            /* Search mode header */
            <div className="flex items-center gap-3">
              <button
                onClick={handleCloseSearch}
                className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback"
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
            /* Default header */
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <MessageSquare size={22} />
                <h1 className="text-lg font-bold">Messages</h1>
              </div>
              <button
                onClick={handleOpenSearch}
                className="p-2.5 rounded-xl hover:bg-white/10 touch-feedback"
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
          onClick={handleRefresh}
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
      <div className="pt-1">
        {loading ? (
          <div className="space-y-1">
            {[1, 2, 3, 4, 5].map((i) => (
              <ChannelSkeleton key={i} />
            ))}
          </div>
        ) : error ? (
          <div className="text-center py-12 px-4">
            <MessageSquare
              size={48}
              className="mx-auto mb-3 text-gray-300 opacity-60"
            />
            <p className="font-medium text-gray-600 dark:text-gray-300">
              Could not load messages
            </p>
            <p className="text-sm text-gray-400 mt-1">{error}</p>
            <button
              onClick={handleRefresh}
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
          <div className="divide-y divide-gray-100 dark:divide-gray-800/50">
            {sortedChannels.map((channel) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                onPress={() => handleChannelPress(channel.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* FAB — New chat button (bottom-right, above tab bar) */}
      {!loading && !error && (
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
