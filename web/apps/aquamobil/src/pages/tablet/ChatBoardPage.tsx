/**
 * ChatBoardPage — the cabin board's Chat view: conversations left, open thread right.
 *
 * WHY TWO PANES RATHER THAN THE PHONE'S TWO SCREENS. On a handheld, opening a
 * conversation replaces the list, because 390px holds one thing at a time. That
 * push-navigation is the cost of the width, not a design choice — and the extra
 * width is exactly what the board buys back. Here the list stays on screen while
 * a thread is open, so the person in the cabin can see a second conversation
 * arrive without leaving the one they are answering. Nothing else changes: same
 * channels, same messages, same composer.
 *
 * THE THREAD IS THE PHONE'S THREAD. <ChatThread/> is the component ChatRoomPage
 * renders (src/components/messaging/ChatThread.tsx) — optimistic send, read
 * cursor, infinite scroll, attachments, voice notes, edit/delete/forward, all of
 * it. This file supplies a heading where the phone supplies a back chevron and
 * nothing more. Re-implementing message rendering for the board would have been a
 * second place for MSG-CRITICAL-055 and friends to come back.
 *
 * SELECTION LIVES IN THE URL, as `?channel=<id>`, mirroring the Board view's
 * `?unit=<id>` (src/pages/tablet/useSelectedUnit.ts) — same reasoning: the board
 * must not navigate away from itself, a display left running all shift comes back
 * to the same conversation after a reload or a service-worker update, and
 * `replace: true` keeps twenty opened threads out of the history stack.
 *
 * WHY THE COMPOSER IS PRESENT HERE, when the Board view deliberately has no log
 * buttons: the board's rule is that FARM RECORDS are made standing at the pen,
 * because an entry made from the cabin is an entry made away from the fish. A
 * message is not a farm record. Somebody coordinating a shift from the cabin desk
 * is doing the thing this device is for, so the thread keeps its full composer.
 *
 * PERMISSIONS: `/messages` and `/messages/:channelId` carry no FeatureRoute in
 * App.tsx — team messaging is open to every mobile role, and the channel list the
 * server returns is already membership-scoped (`myChannels` returns the CURRENT
 * user's channels). This view therefore gates nothing extra and hides nothing
 * extra: it shows precisely the conversations the same account sees on the phone.
 */
import { MessageSquare, MessagesSquare, Plus, RefreshCw, Search, Settings, X } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { ChannelListItem } from '@/components/messaging/ChannelListItem';
import { ChatThread } from '@/components/messaging/ChatThread';
import { Button, DataState, EmptyState, IconButton } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { useChannelDetail } from '@/hooks/useChannelDetail';
import { useChannels } from '@/hooks/useChannels';
import { useMessageSocket } from '@/hooks/useMessageSocket';
import { BoardRegion } from '@/pages/tablet/BoardRegion';
import type { Channel } from '@/types/messaging';
import { toLoadable } from '@/utils/loadable';
import { getChannelDisplayName, isOtherMemberOnline } from '@/utils/messaging-helpers';

/** The query-string key holding the open conversation. */
export const SELECTED_CHANNEL_PARAM = 'channel';

interface ChannelSelection {
  selectedChannelId: string | null;
  selectChannel: (channelId: string | null) => void;
}

/**
 * The open conversation, in the URL. The same seam as useSelectedUnit(), scoped
 * to this view because only this view has two panes that need it — the list
 * writes, the thread reads, and neither has to own the other.
 */
function useSelectedChannel(): ChannelSelection {
  const [searchParams, setSearchParams] = useSearchParams();

  const selectChannel = useCallback(
    (channelId: string | null): void => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (channelId === null) next.delete(SELECTED_CHANNEL_PARAM);
          else next.set(SELECTED_CHANNEL_PARAM, channelId);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return { selectedChannelId: searchParams.get(SELECTED_CHANNEL_PARAM), selectChannel };
}

/** ChannelListItem's own vocabulary for the three channel kinds. */
function avatarTypeOf(channel: Channel): 'dm' | 'group' | 'ai' {
  if (channel.type === 'direct') return 'dm';
  if (channel.type === 'ai') return 'ai';
  return 'group';
}

export function ChatBoardPage(): ReactElement {
  const { selectedChannelId, selectChannel } = useSelectedChannel();

  return (
    <div className="h-full min-h-0 grid gap-3 p-3 grid-cols-[320px_minmax(0,1fr)] board-wide:grid-cols-[380px_minmax(0,1fr)]">
      <ConversationsPane selectedChannelId={selectedChannelId} onSelect={selectChannel} />
      <ThreadPane selectedChannelId={selectedChannelId} />
    </div>
  );
}

/**
 * The left column: every conversation this account is a member of.
 *
 * The region body drops its default padding (`bodyClassName="flex flex-col p-0"`)
 * because ChannelListItem draws a full-bleed row carrying its own padding and its
 * own selected wash. The board's usual card-stack inset would pull the rows off
 * the edges and cost the active row that edge-to-edge highlight — which is the
 * only thing on screen marking which conversation is open.
 */
function ConversationsPane({
  selectedChannelId,
  onSelect,
}: {
  selectedChannelId: string | null;
  onSelect: (channelId: string | null) => void;
}): ReactElement {
  const navigate = useNavigate();
  const { user } = useAuth();
  // socketRef is passed so the list refreshes on `channelUpdated` — a cabin board
  // is watched, not polled by hand, and a new conversation must appear on it
  // without somebody tapping Refresh.
  const { socketRef } = useMessageSocket();
  const { channels, isLoading, error, refetch } = useChannels(socketRef);
  const [search, setSearch] = useState('');

  // WHY a Loadable rather than reading `channels` directly: useChannels hands
  // back `[]` on failure, and "No conversations" rendered by a board that could
  // not reach the messaging subgraph is a claim about the team that nobody
  // checked — the same substitution src/utils/loadable.ts exists to prevent.
  // toLoadable checks the error arm FIRST, so <DataState/> cannot reach its
  // children while the fetch is down.
  const view = toLoadable<Channel[]>({
    data: channels,
    isLoading,
    isError: error !== null,
    error: error ?? undefined,
    refetch,
  });

  // Filter first, then sort by recency: the most recently active conversation is
  // the one somebody in a cabin is most likely to be looking for.
  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matching = term
      ? channels.filter((channel) =>
          getChannelDisplayName(channel, user?.id).toLowerCase().includes(term),
        )
      : channels;
    return [...matching].sort((a, b) => {
      const aAt = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : 0;
      const bAt = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : 0;
      return bAt - aAt;
    });
  }, [channels, search, user?.id]);

  return (
    <BoardRegion
      label="Conversations"
      icon={MessagesSquare}
      bodyClassName="flex flex-col p-0"
      action={
        <IconButton
          aria-label="New message"
          onClick={() => navigate('/messages/new')}
          className="bg-surface-2"
        >
          <Plus size={18} className="text-ink-2" />
        </IconButton>
      }
    >
      <div className="shrink-0 p-3 pb-2">
        {/* The well is the same recessed surface the composer's field uses, so a
            search box on the board and a search box on the phone read alike. */}
        <div className="flex items-center gap-2 rounded-2xl border border-line bg-surface-2 px-3 focus-within:border-acc focus-within:ring-2 focus-within:ring-acc">
          <Search size={16} className="shrink-0 text-ink-3" aria-hidden />
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search conversations"
            // aria-label rather than a placeholder-only field: the placeholder
            // disappears the moment somebody types, taking the control's only
            // accessible name with it.
            aria-label="Search conversations"
            className="min-w-0 flex-1 min-h-touch bg-transparent text-body text-ink-1 placeholder-ink-3 outline-none"
          />
          {search !== '' && (
            <IconButton aria-label="Clear search" onClick={() => setSearch('')}>
              <X size={16} className="text-ink-3" />
            </IconButton>
          )}
        </div>
      </div>

      <DataState
        value={view}
        label="conversations"
        skeleton="row"
        skeletonCount={6}
        empty={
          <EmptyState
            icon={<MessageSquare size={22} />}
            title="No conversations yet"
            description="Start one with your team."
            action={
              <Button variant="primary" onClick={() => navigate('/messages/new')}>
                <Plus size={16} />
                New message
              </Button>
            }
          />
        }
      >
        {() =>
          // A successful fetch that the SEARCH emptied is a third state, distinct
          // from both "no conversations" and "could not load". Saying "no
          // conversations" here would be a claim about the team when the truth is
          // a claim about the search box.
          rows.length === 0 ? (
            <EmptyState
              icon={<Search size={22} />}
              title="No conversations match"
              description={`Nothing matches “${search.trim()}”.`}
              action={
                <Button variant="secondary" onClick={() => setSearch('')}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <div className="flex flex-col">
              {rows.map((channel) => (
                // A hairline between rows of one list — the only place v4 allows
                // a divider outside a card, because the list itself is the surface.
                <div key={channel.id} className="border-b border-line last:border-b-0">
                  <ChannelListItem
                    channelId={channel.id}
                    type={avatarTypeOf(channel)}
                    name={getChannelDisplayName(channel, user?.id)}
                    avatarUrl={channel.avatarUrl ?? undefined}
                    lastMessage={channel.lastMessage?.content ?? undefined}
                    lastMessageAt={channel.lastMessage?.createdAt}
                    unreadCount={channel.unreadCount ?? 0}
                    isActive={channel.id === selectedChannelId}
                    isOnline={isOtherMemberOnline(channel, user?.id)}
                    onPress={onSelect}
                  />
                </div>
              ))}
            </div>
          )
        }
      </DataState>

      {view.status === 'error' && (
        // DataState's own retry lives inside its error card; this is the manual
        // refresh for the ordinary case, kept out of the header so it does not
        // compete with New message for the one slot up there.
        <div className="shrink-0 p-3">
          <Button variant="ghost" block onClick={() => void refetch()}>
            <RefreshCw size={14} />
            Try again
          </Button>
        </div>
      )}
    </BoardRegion>
  );
}

/**
 * The right column: whichever conversation the left column has open.
 *
 * `key={selectedChannelId}` remounts the thread when the selection changes. That
 * is deliberate and not a performance oversight: the thread holds per-conversation
 * UI state — a half-typed reply, an open attachment picker, the scroll position,
 * the read-cursor dedup — and carrying any of it across a switch would show one
 * conversation's draft above another's history.
 */
function ThreadPane({ selectedChannelId }: { selectedChannelId: string | null }): ReactElement {
  const navigate = useNavigate();
  const { user } = useAuth();
  // The SAME per-channel query the thread inside this region already runs, so
  // naming the region costs nothing on the wire and the heading cannot disagree
  // with the row highlighted three hundred pixels to its left.
  const { channel } = useChannelDetail(selectedChannelId ?? undefined);

  if (selectedChannelId === null) {
    return (
      <BoardRegion label="Conversation" icon={MessageSquare}>
        <EmptyState
          icon={<MessageSquare size={22} />}
          title="No conversation open"
          description="Choose one on the left to read and reply here."
        />
      </BoardRegion>
    );
  }

  return (
    <BoardRegion
      // Neutral until the channel actually arrives: a heading is a claim about
      // which conversation is on screen, and there is nothing to base one on yet.
      label={channel ? getChannelDisplayName(channel, user?.id) : 'Conversation'}
      icon={MessageSquare}
      bodyClassName="flex flex-col p-0"
      // The phone's chat header carries this; the board must not quietly drop a
      // surface the handheld offers. Same ungated route, same destination — this
      // is parity, not a new capability.
      action={
        <IconButton
          aria-label="Channel settings"
          onClick={() => navigate(`/messages/${selectedChannelId}/settings`)}
          className="hover:bg-surface-2"
        >
          <Settings size={18} className="text-ink-2" />
        </IconButton>
      }
    >
      <ChatThread key={selectedChannelId} channelId={selectedChannelId} />
    </BoardRegion>
  );
}

export default ChatBoardPage;
