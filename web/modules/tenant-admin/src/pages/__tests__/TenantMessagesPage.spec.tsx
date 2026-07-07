/**
 * TenantMessagesPage responsive master-detail tests.
 *
 * The page shipped with a desktop-only fixed two-pane layout: a hard `w-96`
 * (384px) thread-list column inside an `overflow-hidden` flex row. On a phone
 * viewport (~375px) the list column alone was wider than the screen, squeezing
 * the message pane to zero width — the page looked like it never loaded on
 * mobile. The fix is a master-detail layout: below `md` exactly ONE pane is
 * visible (the list, or the conversation with a back button).
 *
 * jsdom cannot compute real layout, so these are class-contract assertions
 * (tier-3 "make it detectable"): dropping the responsive classes or the back
 * button turns them RED.
 */

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTenantAdminTestQueryClient } from '../../test/query-client';

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------

const { mockThreads, mockMessages } = vi.hoisted(() => ({
  mockThreads: [
    {
      id: 'thread-1',
      subject: 'Billing question',
      lastMessage: 'Hello',
      lastMessageAt: '2026-07-01T10:00:00Z',
      updatedAt: '2026-07-01T10:00:00Z',
      messageCount: 2,
      unreadCount: 0,
      isClosed: false,
    },
  ],
  mockMessages: [
    {
      id: 'msg-1',
      senderType: 'tenant_admin',
      senderName: 'Admin',
      content: 'Hello',
      status: 'read',
      createdAt: '2026-07-01T10:00:00Z',
    },
  ],
}));

vi.mock('../../hooks/useTenantData', () => ({
  useMessageThreads: () => ({ data: mockThreads, isLoading: false, error: null }),
  useThreadMessages: (threadId: string | null) => ({
    data: threadId ? mockMessages : [],
    isLoading: false,
  }),
  useSendMessage: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCreateThread: () => ({ mutateAsync: vi.fn(), isPending: false }),
  tenantKeys: { threads: () => ['tenant', 'tenant-1', 'threads'] },
}));

import TenantMessagesPage from '../TenantMessagesPage';

function renderPage(): void {
  render(
    <QueryClientProvider client={createTenantAdminTestQueryClient()}>
      <TenantMessagesPage />
    </QueryClientProvider>,
  );
}

/** Nearest ancestor (or self) carrying a class, for layout-contract checks. */
function paneOf(el: HTMLElement, marker: string): Element | null {
  return el.closest(`[class*="${marker}"]`);
}

describe('TenantMessagesPage — responsive master-detail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom does not implement scrollIntoView (used by the messages auto-scroll).
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('with no selection: full-width list on mobile, message pane hidden below md', () => {
    renderPage();

    // Thread list column is full-width on mobile, fixed 384px only from md up.
    const listPane = paneOf(screen.getByPlaceholderText('Search conversations...'), 'md:w-96');
    expect(listPane).not.toBeNull();
    expect(listPane).toHaveClass('w-full', 'md:w-96', 'flex');
    expect(listPane).not.toHaveClass('hidden');

    // Message pane ("Select a conversation" empty state) is hidden below md.
    const messagePane = paneOf(screen.getByText('Select a conversation'), 'bg-gray-50');
    expect(messagePane).not.toBeNull();
    expect(messagePane).toHaveClass('hidden', 'md:flex');
  });

  it('selecting a thread swaps the panes on mobile and shows a back button', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByText('Billing question'));

    // Message pane becomes the visible pane…
    const messagePane = paneOf(screen.getByLabelText('Back to conversations'), 'bg-gray-50');
    expect(messagePane).toHaveClass('flex');
    expect(messagePane).not.toHaveClass('hidden');

    // …and the list hides below md (still visible from md up: master-detail).
    const listPane = paneOf(screen.getByPlaceholderText('Search conversations...'), 'md:w-96');
    expect(listPane).toHaveClass('hidden', 'md:flex');

    // The back affordance is mobile-only.
    expect(screen.getByLabelText('Back to conversations')).toHaveClass('md:hidden');
  });

  it('the back button returns to the thread list (clears the selection)', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByText('Billing question'));
    await user.click(screen.getByLabelText('Back to conversations'));

    // Back to the empty state → list pane visible again on mobile.
    const listPane = paneOf(screen.getByPlaceholderText('Search conversations...'), 'md:w-96');
    expect(listPane).toHaveClass('flex');
    expect(listPane).not.toHaveClass('hidden');
    expect(screen.getByText('Select a conversation')).toBeInTheDocument();
  });

  it('stats grid stacks 2-up on mobile (repo responsive idiom)', () => {
    renderPage();

    const statsGrid = paneOf(screen.getByText('Total Threads'), 'grid');
    expect(statsGrid).toHaveClass('grid-cols-2', 'sm:grid-cols-4');
  });

  it('the page height uses dvh so mobile browser chrome cannot push the composer off-screen', () => {
    renderPage();

    const root = paneOf(screen.getByText('Messages'), '100dvh');
    expect(root).not.toBeNull();
  });
});
