/**
 * ChannelListPage specs — FAZ 3 wiring at the list level.
 *
 * The page mounts the socket (channel-room decision: join-all keeps the list
 * live without the removed 60s poll) and renders safe previews: a media
 * lastMessage shows the localized label (never the raw URL/storage key), a
 * deleted/absent lastMessage falls back to the neutral empty preview.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { routeGraphql } from '../../test-utils/mockGraphqlClient';
import { ioSpy, resetSocketMock } from '../../test-utils/mockSocketIo';
import { requestMock, TEST_USER_ID } from '../../test-utils/sharedUiMock';
import type { Channel } from '../../types/messaging';
import ChannelListPage from '../ChannelListPage';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../test-utils/sharedUiMock')).createSharedUiMock(),
);
vi.mock('socket.io-client', async () =>
  (await import('../../test-utils/mockSocketIo')).socketIoModuleMock(),
);

const CHANNEL = 'cccccccc-3333-4444-8555-666666666666';

function makeChannel(lastMessage: Channel['lastMessage']): Channel {
  return {
    id: CHANNEL,
    type: 'DIRECT',
    name: null,
    description: null,
    avatarUrl: null,
    isArchived: false,
    aiPersona: null,
    unreadCount: 3,
    memberCount: 2,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    lastMessage,
    members: [
      {
        id: 'm1',
        userId: TEST_USER_ID,
        role: 'MEMBER',
        user: { id: TEST_USER_ID, firstName: 'Panel', lastName: 'Operator', profileImageUrl: null },
      },
      {
        id: 'm2',
        userId: 'u2',
        role: 'MEMBER',
        user: { id: 'u2', firstName: 'Mehmet', lastName: 'Demir', profileImageUrl: null },
      },
    ],
  };
}

function lastMessageOf(
  overrides: Partial<NonNullable<Channel['lastMessage']>>,
): NonNullable<Channel['lastMessage']> {
  return {
    id: 'msg-1',
    channelId: CHANNEL,
    senderId: 'u2',
    content: 'plain preview',
    contentType: 'TEXT',
    isDeleted: false,
    isAiGenerated: false,
    createdAt: '2026-09-16T10:00:00Z',
    editedAt: null,
    sender: null,
    ...overrides,
  } as NonNullable<Channel['lastMessage']>;
}

function renderList(): void {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={['/messaging']}>
        <ChannelListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  requestMock.mockReset();
  resetSocketMock();
});

describe('ChannelListPage', () => {
  it('mounts the socket (join-all liveness; the 60s poll is gone)', async () => {
    routeGraphql([
      {
        match: 'query MyChannels',
        result: () => ({ myChannels: { total: 1, items: [makeChannel(null)] } }),
      },
    ]);
    renderList();
    await screen.findByText('Mehmet Demir');
    expect(ioSpy).toHaveBeenCalledWith('/messaging', expect.anything());
  });

  it('offers the AI entry point (the stub session holds ai_assistant:use)', async () => {
    routeGraphql([
      {
        match: 'query MyChannels',
        result: () => ({ myChannels: { total: 0, items: [] } }),
      },
    ]);
    renderList();
    expect(await screen.findByRole('button', { name: 'New AI conversation' })).toBeVisible();
  });

  it('renders a TEXT lastMessage as the preview', async () => {
    routeGraphql([
      {
        match: 'query MyChannels',
        result: () => ({
          myChannels: { total: 1, items: [makeChannel(lastMessageOf({}))] },
        }),
      },
    ]);
    renderList();
    expect(await screen.findByText('plain preview')).toBeVisible();
  });

  it.each([
    ['IMAGE', 'https://cdn.example.test/x.png', '[Image]'],
    ['FILE', 'https://cdn.example.test/x.pdf', '[File]'],
    ['VOICE', 'https://cdn.example.test/x.ogg', '[Voice message]'],
  ] as const)(
    'a %s lastMessage previews the localized label, never the media reference',
    async (contentType, content, label) => {
      routeGraphql([
        {
          match: 'query MyChannels',
          result: () => ({
            myChannels: {
              total: 1,
              items: [makeChannel(lastMessageOf({ contentType, content }))],
            },
          }),
        },
      ]);
      renderList();
      expect(await screen.findByText(label)).toBeVisible();
      expect(screen.queryByText(content)).not.toBeInTheDocument();
    },
  );

  it('a deleted lastMessage falls back to the neutral empty preview', async () => {
    routeGraphql([
      {
        match: 'query MyChannels',
        result: () => ({
          myChannels: {
            total: 1,
            items: [makeChannel(lastMessageOf({ isDeleted: true, content: null }))],
          },
        }),
      },
    ]);
    renderList();
    expect(await screen.findByText('No messages yet')).toBeVisible();
  });
});
