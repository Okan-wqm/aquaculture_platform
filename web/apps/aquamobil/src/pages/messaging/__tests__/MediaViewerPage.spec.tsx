import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MediaViewerPage } from '../MediaViewerPage';

import { useMessages } from '@/hooks/useMessages';
import type { Message } from '@/types/messaging';

vi.mock('@/hooks/useMessages', () => ({
  useMessages: vi.fn(),
}));

const mockUseMessages = vi.mocked(useMessages);
type UseMessagesResult = ReturnType<typeof useMessages>;

function messageWithAttachment(attachmentId: string, fileName = 'tank-photo.jpg'): Message {
  return {
    id: `message-${attachmentId}`,
    channelId: 'channel-1',
    senderId: 'user-1',
    content: null,
    contentType: 'IMAGE',
    parentId: null,
    forwardedFrom: null,
    isDeleted: false,
    createdAt: '2026-06-18T10:00:00.000Z',
    editedAt: null,
    metadata: null,
    sender: {
      id: 'user-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      isOnline: true,
    },
    attachments: [
      {
        id: attachmentId,
        originalFilename: fileName,
        mimeType: 'image/jpeg',
        fileSize: 1024,
        width: 1600,
        height: 900,
        durationSeconds: null,
        thumbnailUrl: 'https://cdn.example.test/thumb.jpg',
        downloadUrl: `https://cdn.example.test/${attachmentId}.jpg`,
      },
    ],
    receipts: [],
    reactionSummary: [],
  };
}

function setUseMessagesResult(overrides: Partial<UseMessagesResult> = {}): UseMessagesResult {
  const result = {
    messages: [],
    isLoading: false,
    error: null,
    fetchNextPage: vi.fn<UseMessagesResult['fetchNextPage']>(),
    hasNextPage: false,
    isFetchingNextPage: false,
  };

  const merged = { ...result, ...overrides };
  mockUseMessages.mockReturnValue(merged);
  return merged;
}

function renderViewer(path = '/messages/channel-1/media/att-1'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/messages/:channelId/media/:attachmentId" element={<MediaViewerPage />} />
        <Route path="/messages/media/:attachmentId" element={<MediaViewerPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MediaViewerPage (MSG-CRITICAL-053)', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders media from the channel message attachment SSoT', () => {
    setUseMessagesResult({
      messages: [messageWithAttachment('att-1', 'cage-inspection.jpg')],
    });

    renderViewer();

    expect(mockUseMessages).toHaveBeenCalledWith('channel-1');
    expect(screen.getByAltText('cage-inspection.jpg').getAttribute('src')).toBe(
      'https://cdn.example.test/att-1.jpg',
    );
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
  });

  it('fetches older message pages until the requested attachment is found', async () => {
    const fetchNextPage = vi.fn<UseMessagesResult['fetchNextPage']>();
    setUseMessagesResult({
      messages: [messageWithAttachment('different-attachment')],
      fetchNextPage,
      hasNextPage: true,
    });

    renderViewer('/messages/channel-1/media/att-older');

    await waitFor(() => expect(fetchNextPage).toHaveBeenCalledTimes(1));
  });

  it('does not show the first channel media item when the requested attachment is absent', () => {
    setUseMessagesResult({
      messages: [messageWithAttachment('different-attachment', 'wrong-photo.jpg')],
    });

    renderViewer('/messages/channel-1/media/missing-attachment');

    expect(screen.getByText('Media not found')).toBeTruthy();
    expect(screen.queryByAltText('wrong-photo.jpg')).toBeNull();
  });

  it('fails closed when a legacy route lacks channel context', () => {
    setUseMessagesResult();

    renderViewer('/messages/media/att-1');

    expect(mockUseMessages).toHaveBeenCalledWith(undefined);
    expect(screen.getByText('Channel context missing for this media item')).toBeTruthy();
  });
});
