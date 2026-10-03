import { clsx } from 'clsx';
import type { ReactElement } from 'react';

import { ChannelAvatar } from './ChannelAvatar';
import { UnreadBadge } from './UnreadBadge';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChannelListItemProps {
  /** Unique channel identifier. */
  channelId: string;
  /** Channel type. */
  type: 'dm' | 'group' | 'ai';
  /** Display name (other user's name for DM, channel name for group). */
  name: string;
  /** Primary avatar image URL. */
  avatarUrl?: string;
  /** Second member avatar URL (group stacked display). */
  secondAvatarUrl?: string;
  /** Preview of the last message (truncated by CSS). */
  lastMessage?: string;
  /** ISO timestamp of the last message. */
  lastMessageAt?: string;
  /** Number of unread messages in this channel. */
  unreadCount: number;
  /** Whether this channel is currently selected / active. */
  isActive?: boolean;
  /** Whether the other user is online (DM only). */
  isOnline?: boolean;
  /** Callback when the row is tapped. */
  onPress: (channelId: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * WHY relative time: Field workers don't need exact timestamps in the
 * channel list. "2m ago" vs "1h" vs "Yesterday" is enough to gauge
 * recency at a glance while scanning the list with one hand.
 */
function formatRelativeTime(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  if (isNaN(then)) return '';

  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHr < 24) return `${diffHr}h`;
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay}d`;

  return new Date(isoDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * ChannelListItem -- single row in the channel/conversation list.
 *
 * WHY 48dp min height: ADR-012 mandates glove-friendly touch targets.
 * Aquaculture field workers wear wet gloves -- small tap areas cause
 * mis-taps and frustration in the field.
 *
 * WHY entire row is a button: Follows WhatsApp/Telegram convention where
 * the full row is the tap target, not a small clickable area.
 */
export function ChannelListItem({
  channelId,
  type,
  name,
  avatarUrl,
  secondAvatarUrl,
  lastMessage,
  lastMessageAt,
  unreadCount,
  isActive = false,
  isOnline = false,
  onPress,
}: ChannelListItemProps): ReactElement {
  return (
    <button
      onClick={() => onPress(channelId)}
      className={clsx(
        'w-full flex items-center gap-3 px-4 py-3 min-h-[64px] text-left transition-colors touch-feedback',
        // Active = the accent's own dim wash, which is how v4 says "selected"
        // everywhere; inactive rows are the plain content surface.
        isActive ? 'bg-acc-dim' : 'bg-surface-1 hover:bg-surface-2',
      )}
    >
      {/* Avatar */}
      <ChannelAvatar
        type={type}
        name={name}
        imageUrl={avatarUrl}
        secondImageUrl={secondAvatarUrl}
        isOnline={isOnline}
        size="md"
      />

      {/* Name + last message preview */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          {/* Unread rows climb one step up the ink ramp rather than changing
              colour — the badge and the accent timestamp carry the state. */}
          <span
            className={clsx(
              'text-body font-semibold truncate',
              unreadCount > 0 ? 'text-ink-1' : 'text-ink-2',
            )}
          >
            {name}
          </span>
          {lastMessageAt && (
            <span
              className={clsx(
                'text-meta shrink-0',
                unreadCount > 0 ? 'text-acc font-semibold' : 'text-ink-3 font-medium',
              )}
            >
              {formatRelativeTime(lastMessageAt)}
            </span>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 mt-0.5">
          <p
            className={clsx(
              'text-meta truncate',
              unreadCount > 0 ? 'text-ink-2 font-medium' : 'text-ink-3',
            )}
          >
            {lastMessage ?? 'No messages yet'}
          </p>
          {unreadCount > 0 && <UnreadBadge count={unreadCount} size="md" color="blue" />}
        </div>
      </div>
    </button>
  );
}
