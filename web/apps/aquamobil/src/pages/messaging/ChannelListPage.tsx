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
 *
 * WHY the shared AppHeader rather than the ocean-gradient banner this had: this
 * is a dock destination like Today, Units and Reports, and before v4 it was the
 * only one wearing a different header — different height, different title size,
 * no route to the account. The gradient also cost contrast in sunlight, which is
 * the condition the whole app is designed for.
 */

import { clsx } from 'clsx';
import { MessageSquare, Plus, RefreshCw, Search, WifiOff, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { AppHeader } from '@/components/AppHeader';
import { ChannelAvatar } from '@/components/messaging/ChannelAvatar';
import { UnreadBadge } from '@/components/messaging/UnreadBadge';
import { Button, EmptyState, IconButton, Skeleton } from '@/components/ui';
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
      className="w-full flex items-center gap-3 px-4 py-3 min-h-touch text-left touch-feedback transition-all active:bg-surface-2"
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
          {/* Unread rows climb one step up the ink ramp rather than changing
              colour — the badge and the accent timestamp carry the state. This
              mirrors ChannelListItem so the same row reads the same way
              wherever it is drawn. */}
          <h3
            className={clsx(
              'text-body truncate',
              hasUnread ? 'font-bold text-ink-1' : 'font-medium text-ink-2',
            )}
          >
            {displayName}
          </h3>
          {lastMsgTime && (
            <span
              className={clsx(
                'text-meta flex-shrink-0',
                hasUnread ? 'font-semibold text-acc' : 'text-ink-3',
              )}
            >
              {formatRelativeTime(lastMsgTime)}
            </span>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 mt-0.5">
          <p
            className={clsx(
              'text-meta truncate flex-1',
              hasUnread ? 'font-medium text-ink-2' : 'text-ink-3',
            )}
          >
            {lastMsgContent
              ? channel.type === 'group' && lastMsgSender
                ? `${lastMsgSender}: ${lastMsgContent}`
                : lastMsgContent
              : 'No messages yet'}
          </p>

          {/* The shared badge caps at 99+ and announces itself, replacing the
              hand-rolled 10px pill that did the same arithmetic silently. */}
          {hasUnread && <UnreadBadge count={channel.unreadCount ?? 0} size="md" color="blue" />}

          {channel.type === 'group' && !hasUnread && (
            <span className="text-meta text-ink-3 flex-shrink-0">{channel.memberCount ?? 0}</span>
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
    if (!notificationRef || !isConnected || resolvingNotificationRef.current === notificationRef) {
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
      const aTime = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : 0;
      const bTime = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : 0;
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
  const errorMsg = error
    ? error instanceof Error
      ? error.message
      : 'Failed to load channels'
    : null;

  return (
    // MOB-MEDIUM-012: bounded flex column (matching NotificationsPage) so the
    // channel list virtualizes inside its own scroll region instead of paging
    // the whole document — the header stays put while a large membership scrolls.
    // The page ground comes from <body>, so no background is set here.
    <div className="h-screen overflow-hidden flex flex-col">
      <AppHeader
        title="Messages"
        subtitle={channels.length > 0 ? `${channels.length} conversations` : undefined}
        actions={
          // Hidden while the field is open — the field IS the search affordance
          // at that point, which is the same toggle the gradient header had.
          isSearchOpen ? undefined : (
            <IconButton
              aria-label="Search conversations"
              onClick={handleOpenSearch}
              className="bg-surface-2 rounded-xl"
            >
              <Search size={18} className="text-ink-2" />
            </IconButton>
          )
        }
      />

      {isSearchOpen && (
        <div className="flex items-center gap-2 px-4 pb-2">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search conversations..."
            aria-label="Search conversations"
            // The well is a recessed surface, matching the composer's field.
            className="flex-1 min-w-0 rounded-2xl border border-line bg-surface-2 px-4 py-3 text-body text-ink-1 placeholder-ink-3 outline-none focus:ring-2 focus:ring-acc focus:border-acc transition-colors"
          />
          <IconButton aria-label="Close search" onClick={handleCloseSearch}>
            <X size={20} className="text-ink-3" />
          </IconButton>
        </div>
      )}

      {/* Pull-to-refresh button */}
      <div className="px-4 pt-1 flex justify-end">
        <Button
          variant="ghost"
          onClick={() => {
            void handleRefresh();
          }}
          disabled={isRefreshing}
          className="text-acc text-body px-2"
        >
          <RefreshCw size={14} className={clsx(isRefreshing && 'animate-spin')} />
          {isRefreshing ? 'Refreshing...' : 'Refresh'}
        </Button>
      </div>

      {/* Channel list */}
      <div className="pt-1 flex-1 min-h-0 flex flex-col">
        {loading ? (
          <div className="px-4">
            <Skeleton variant="row" count={5} />
          </div>
        ) : errorMsg ? (
          // tone="error" is the whole point: on a boat with intermittent signal
          // "no conversations" and "we could not fetch them" must not look alike.
          <EmptyState
            tone="error"
            icon={<WifiOff size={22} />}
            title="Could not load messages"
            description={errorMsg}
            action={
              <Button
                variant="primary"
                onClick={() => {
                  void handleRefresh();
                }}
              >
                <RefreshCw size={16} />
                Retry
              </Button>
            }
          />
        ) : sortedChannels.length === 0 ? (
          <EmptyState
            icon={<MessageSquare size={22} />}
            title={searchQuery ? 'No conversations found' : 'No messages yet'}
            description={
              searchQuery ? 'Try a different search term' : 'Start a conversation with your team'
            }
            action={
              searchQuery ? undefined : (
                <Button variant="primary" onClick={handleNewChat}>
                  <Plus size={16} />
                  New Message
                </Button>
              )
            }
          />
        ) : (
          <VirtualList
            items={sortedChannels}
            getKey={(channel) => channel.id}
            estimateSize={() => 72}
            className="flex-1 min-h-0"
            renderItem={(channel) => (
              // A hairline between rows of one list — the only place v4 allows a
              // divider outside a card, because the list itself is the surface.
              <div className="border-b border-line">
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

      {/* FAB -- New chat button (bottom-right, above tab bar).
          The accent fill plus its own halo replaces the ocean gradient: one teal
          carries every action, and the halo tracks the theme. */}
      {!loading && !errorMsg && (
        <button
          onClick={handleNewChat}
          className="fixed bottom-24 right-5 w-14 h-14 min-h-touch min-w-touch bg-acc text-acc-on rounded-full shadow-acc flex items-center justify-center touch-feedback transition-transform active:scale-95 z-40"
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
