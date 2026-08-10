/**
 * ChatRoomPage -- the handheld's full-screen chat room.
 *
 * WHAT IS LEFT HERE IS THE HEADER. Everything below it — history, infinite
 * scroll, read cursor, composer, attachments, voice, edit/delete/forward — moved
 * to <ChatThread/> (src/components/messaging/ChatThread.tsx) when the cabin board
 * gained a two-pane Chat view. The two shells open the SAME conversation and
 * differ only in how it is titled: a back chevron and a presence line on a phone,
 * a column heading beside the conversation list on a board. Keeping one thread
 * implementation is what stops the board from becoming a second place for the
 * message-cache, edit-mode and offline-attachment defects to reappear.
 *
 * The header stays here rather than becoming a prop of the thread because it is
 * the part that genuinely differs, and a `header` slot would only be a way of
 * writing this file inside the other one.
 */

import { ArrowLeft, Settings } from 'lucide-react';
import { useMemo, type JSX } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { ChannelAvatar } from '@/components/messaging/ChannelAvatar';
import { ChatThread } from '@/components/messaging/ChatThread';
import { IconButton } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { useChannelDetail } from '@/hooks/useChannelDetail';
import { getChannelDisplayName, isOtherMemberOnline } from '@/utils/messaging-helpers';

/** ChatRoomPage renders a full-screen chat interface for a specific channel. */
export function ChatRoomPage(): JSX.Element {
  const navigate = useNavigate();
  const { channelId } = useParams<{ channelId: string }>();
  const { user } = useAuth();
  // The same query the thread reads, served from one React Query cache entry —
  // the header needs the channel's name and presence, the thread needs its
  // members and type.
  const { channel } = useChannelDetail(channelId);

  // Display name and presence for the header. The rule lives in
  // messaging-helpers so this header, the phone's channel list and the board's
  // Chat view cannot call one conversation three different things. "Chat" is the
  // pre-load placeholder, before the channel has arrived at all.
  const displayName = useMemo(
    () => (channel ? getChannelDisplayName(channel, user?.id) : 'Chat'),
    [channel, user?.id],
  );

  const isOtherOnline = useMemo(
    () => (channel ? isOtherMemberOnline(channel, user?.id) : false),
    [channel, user?.id],
  );

  const statusText =
    channel?.type === 'direct'
      ? isOtherOnline
        ? 'Online'
        : 'Offline'
      : channel
        ? `${channel.memberCount ?? 0} members`
        : '';

  const avatarType = channel?.type === 'direct' ? 'dm' : channel?.type === 'ai' ? 'ai' : 'group';

  return (
    // The page ground comes from <body>, so no background is set here.
    <div className="flex flex-col h-screen">
      {/* Header. NOT the shared AppHeader: a chat header carries the channel
          avatar, the presence line and a tap target that opens settings, none of
          which AppHeader models — it renders a brand mark or a back chevron and
          a plain string title. Swapping it in would cost the avatar. */}
      <div className="bg-surface-1 border-b border-line flex-shrink-0 z-10">
        <div className="flex items-center gap-3 px-3 py-3 pt-safe-top">
          {/* IconButton supplies the touch floor and the accessible name this
              icon-only control was missing. */}
          <IconButton
            size="lg"
            onClick={() => navigate('/messages')}
            className="-ml-1 hover:bg-surface-2"
            aria-label="Back to messages"
          >
            <ArrowLeft size={22} className="text-ink-2" />
          </IconButton>

          <div
            className="flex-1 min-w-0 flex items-center gap-3 cursor-pointer"
            role="button"
            tabIndex={0}
            onClick={() => navigate(`/messages/${channelId}/settings`)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                navigate(`/messages/${channelId}/settings`);
              }
            }}
          >
            <ChannelAvatar
              type={avatarType}
              name={displayName}
              imageUrl={channel?.avatarUrl ?? undefined}
              isOnline={isOtherOnline}
              size="sm"
            />
            <div className="min-w-0">
              <h1 className="text-title font-bold text-ink-1 truncate">{displayName}</h1>
              {/* text-meta is 12px, the sunlight floor — it replaces an 11px
                  arbitrary size, so it LOWERS the tiny-text ratchet. */}
              {statusText && <p className="text-meta text-ink-3">{statusText}</p>}
            </div>
          </div>

          <IconButton
            size="lg"
            onClick={() => navigate(`/messages/${channelId}/settings`)}
            className="hover:bg-surface-2"
            aria-label="Channel settings"
          >
            <Settings size={20} className="text-ink-2" />
          </IconButton>
        </div>
      </div>

      <ChatThread channelId={channelId} />
    </div>
  );
}
