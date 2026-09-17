/**
 * The Chat board view is the one place in this app where two panes have to agree
 * with each other, so the contract worth pinning is the seam between them:
 * choosing a conversation on the left fills the right WITHOUT navigating away
 * from the board, the selection survives in the URL, and the thread is remounted
 * per conversation so one channel's half-typed reply cannot appear above
 * another's history.
 *
 * Plus the standing rule this app has broken seven times: a failed channel fetch
 * must never render as "No conversations yet". "Nobody has messaged you" and "we
 * could not ask" are different facts about a team.
 *
 * <ChatThread/> is stubbed — it is the phone's thread, tested where it lives and
 * dragging ten hooks and a socket behind it. What this file checks is that the
 * board mounts it with the right channel.
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { type ReactElement } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatBoardPage } from '../ChatBoardPage';

// The thread itself belongs to the phone and is tested there; the board's side
// of the contract is only WHICH channel it hands over.
vi.mock('@/components/messaging/ChatThread', () => ({
  ChatThread: ({ channelId }: { channelId: string | undefined }): ReactElement => (
    <span data-testid="chat-thread">{`thread:${channelId ?? 'none'}`}</span>
  ),
}));

const mockUseChannels = vi.fn();
vi.mock('@/hooks/useChannels', () => ({ useChannels: (): unknown => mockUseChannels() }));

const mockUseChannelDetail = vi.fn();
vi.mock('@/hooks/useChannelDetail', () => ({
  useChannelDetail: (id: string | undefined): unknown => mockUseChannelDetail(id),
}));

vi.mock('@/hooks/useMessageSocket', () => ({
  useMessageSocket: (): unknown => ({ socketRef: { current: null } }),
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: (): unknown => ({ user: { id: 'me' } }) }));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: (): unknown => mockNavigate };
});

function groupChannel(id: string, name: string, unread = 0): unknown {
  return {
    id,
    type: 'group',
    name,
    description: null,
    avatarUrl: null,
    createdBy: null,
    isArchived: false,
    createdAt: '2026-08-01T08:00:00.000Z',
    updatedAt: '2026-08-01T08:00:00.000Z',
    memberCount: 4,
    unreadCount: unread,
    lastMessage: {
      id: `m-${id}`,
      senderId: 'other',
      content: `latest in ${name}`,
      createdAt: '2026-08-06T09:00:00.000Z',
    },
  };
}

/** A DM whose members are loaded — the case where the channel NAME is not the label. */
function directChannel(id: string): unknown {
  return {
    id,
    type: 'direct',
    name: null,
    description: null,
    avatarUrl: null,
    createdBy: null,
    isArchived: false,
    createdAt: '2026-08-01T08:00:00.000Z',
    updatedAt: '2026-08-01T08:00:00.000Z',
    unreadCount: 0,
    lastMessage: null,
    members: [
      { userId: 'me', user: { displayName: 'Me' } },
      { userId: 'other', user: { displayName: 'Ola Nordvik', isOnline: true } },
    ],
  };
}

/** Where the router thinks we are — the proof that selecting is not navigating. */
function LocationProbe(): ReactElement {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function renderView(path = '/board/chat'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ChatBoardPage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseChannels.mockReturnValue({
    channels: [groupChannel('c1', 'Site A crew'), groupChannel('c2', 'Feed planning')],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
  mockUseChannelDetail.mockReturnValue({ channel: null, isLoading: false });
});

afterEach(cleanup);

describe('ChatBoardPage — the board Chat view', () => {
  it('lays the conversation list and the open thread side by side', () => {
    renderView();
    expect(screen.getByRole('region', { name: 'Conversations' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Conversation' })).toBeTruthy();
  });

  it('waits for a choice rather than opening whatever is first', () => {
    renderView();
    expect(screen.getByText('No conversation open')).toBeTruthy();
    expect(screen.queryByTestId('chat-thread')).toBeNull();
  });

  it('fills the right pane on selection WITHOUT leaving the board', () => {
    renderView();

    fireEvent.click(screen.getByRole('button', { name: /Site A crew/ }));

    expect(screen.getByTestId('chat-thread').textContent).toBe('thread:c1');
    // Same route, only the query string moved — the list is still on screen.
    expect(screen.getByTestId('location').textContent).toBe('/board/chat?channel=c1');
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Feed planning/ })).toBeTruthy();
  });

  it('opens the conversation a reloaded URL names', () => {
    renderView('/board/chat?channel=c2');
    expect(screen.getByTestId('chat-thread').textContent).toBe('thread:c2');
  });

  it('titles the open pane with the channel, once the channel has arrived', () => {
    mockUseChannelDetail.mockReturnValue({
      channel: groupChannel('c2', 'Feed planning'),
      isLoading: false,
    });
    renderView('/board/chat?channel=c2');

    expect(screen.getByRole('region', { name: 'Feed planning' })).toBeTruthy();
  });

  it('names a DM after the other person, not after the stored channel name', () => {
    mockUseChannels.mockReturnValue({
      channels: [directChannel('dm1')],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    renderView();

    expect(screen.getByRole('button', { name: /Ola Nordvik/ })).toBeTruthy();
  });

  it('says conversations are unavailable rather than "No conversations yet"', () => {
    mockUseChannels.mockReturnValue({
      channels: [],
      isLoading: false,
      error: new Error('messaging subgraph unreachable'),
      refetch: vi.fn(),
    });
    renderView();

    expect(screen.getByText(/Could not load conversations/)).toBeTruthy();
    expect(screen.queryByText('No conversations yet')).toBeNull();
  });

  it('keeps a team with no conversations distinct from an unreachable one', () => {
    mockUseChannels.mockReturnValue({
      channels: [],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    renderView();

    expect(screen.getByText('No conversations yet')).toBeTruthy();
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });

  it('keeps an emptied search distinct from an empty team', () => {
    renderView();

    fireEvent.change(screen.getByLabelText('Search conversations'), {
      target: { value: 'nothing matches this' },
    });

    // A claim about the search box, not a claim about the team.
    expect(screen.getByText('No conversations match')).toBeTruthy();
    expect(screen.queryByText('No conversations yet')).toBeNull();
  });

  it('filters the list as the cabin types', () => {
    renderView();

    fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: 'feed' } });

    expect(screen.getByRole('button', { name: /Feed planning/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Site A crew/ })).toBeNull();
  });

  it('remounts the thread per conversation so no draft crosses over', () => {
    renderView();

    fireEvent.click(screen.getByRole('button', { name: /Site A crew/ }));
    const first = screen.getByTestId('chat-thread');
    expect(first.textContent).toBe('thread:c1');

    fireEvent.click(screen.getByRole('button', { name: /Feed planning/ }));

    // A DIFFERENT DOM node, not the same one re-rendered with new props: the
    // `key` did its job, so the thread's own state — a half-typed reply, an open
    // attachment picker, the scroll position — went with the conversation it
    // belonged to instead of following the reader into the next one.
    const second = screen.getByTestId('chat-thread');
    expect(second).not.toBe(first);
    expect(second.textContent).toBe('thread:c2');
  });

  it('offers the same New message destination the phone does', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    expect(mockNavigate).toHaveBeenCalledWith('/messages/new');
  });

  it('keeps the channel-settings route the phone header offers', () => {
    // The board removes ACTIONS that belong at the pen (acknowledging an alarm,
    // logging an entry). Messaging admin is not one of those, and silently
    // dropping it would make the board a lesser client for no stated reason.
    renderView('/board/chat?channel=c1');

    fireEvent.click(screen.getByRole('button', { name: 'Channel settings' }));
    expect(mockNavigate).toHaveBeenCalledWith('/messages/c1/settings');
  });

  it('offers no settings control while no conversation is open', () => {
    renderView();
    expect(screen.queryByRole('button', { name: 'Channel settings' })).toBeNull();
  });
});
