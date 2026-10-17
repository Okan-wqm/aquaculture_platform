/**
 * NotificationPanel — the header's bell (FE-HIGH-089, console a11y review).
 *
 * Pins what a reader of the console header hears and sees: the bell's name
 * and its unread count, the panel's name, heading and actions, the relative
 * times and the older dates all follow the active locale; the unread badge
 * holds 4.5:1 for its 12px text; and the panel takes the console header's
 * placement, hanging from the header at its gutter where the row wraps.
 */
import '@testing-library/jest-dom/vitest';
import { I18nProvider, type SupportedLocale } from '@aquaculture/shared-ui';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InAppNotification } from '@/hooks/useNotifications';

const NOW = new Date('2026-10-16T12:00:00Z');

function notification(id: string, createdAt: string): InAppNotification {
  return { id, title: `Notice ${id}`, body: 'Body', isRead: false, createdAt };
}

const state = vi.hoisted(() => ({
  notifications: [] as InAppNotification[],
  unreadCount: 0,
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/hooks/useNotifications', () => ({
  useNotifications: () => ({
    notifications: state.notifications,
    unreadCount: state.unreadCount,
    loading: false,
    markAsRead: vi.fn(),
    markAllAsRead: vi.fn(),
    fetchNotifications: vi.fn(),
    parseNotificationData: () => null,
  }),
}));

import { NotificationPanel } from '../NotificationPanel';

function renderBell(locale: SupportedLocale = 'en'): void {
  render(
    <I18nProvider locale={locale}>
      <NotificationPanel />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  state.notifications = [
    notification('a', '2026-10-16T11:58:00Z'),
    notification('b', '2026-10-01T09:00:00Z'),
  ];
  state.unreadCount = 3;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('NotificationPanel — language', () => {
  it('names the bell with its unread count, and the panel, in the active locale', async () => {
    renderBell('tr');
    const bell = screen.getByRole('button', { name: 'Bildirimler, 3 okunmamış' });
    await userEvent.click(bell);
    const panel = screen.getByRole('dialog', { name: 'Bildirimler' });
    expect(within(panel).getByRole('heading', { name: 'Bildirimler' })).toBeInTheDocument();
    expect(within(panel).getByText('3 yeni')).toBeInTheDocument();
    expect(
      within(panel).getByRole('button', { name: 'Tümünü okundu işaretle' }),
    ).toBeInTheDocument();
    expect(within(panel).getByText('2 dk önce')).toBeInTheDocument();
    // An older date is formatted for the locale, not as en-US.
    expect(within(panel).getByText('1 Eki')).toBeInTheDocument();
  });

  it('speaks English when the reader does, and drops the count at zero', async () => {
    state.unreadCount = 0;
    renderBell('en');
    await userEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getByText('2m ago')).toBeInTheDocument();
  });

  it('localizes the empty state', async () => {
    state.notifications = [];
    state.unreadCount = 0;
    renderBell('tr');
    await userEvent.click(screen.getByRole('button', { name: 'Bildirimler' }));
    expect(screen.getByText('Bildirim yok')).toBeInTheDocument();
  });

  it('localizes "load more" with the count left', async () => {
    state.notifications = Array.from({ length: 53 }, (_, index) =>
      notification(`n${index}`, '2026-10-16T11:00:00Z'),
    );
    renderBell('tr');
    await userEvent.click(screen.getByRole('button', { name: /Bildirimler/ }));
    expect(screen.getByRole('button', { name: 'Daha fazla yükle (3 kaldı)' })).toBeInTheDocument();
  });
});

describe('NotificationPanel — badge and placement', () => {
  it('paints the unread badge on error-600, where white 12px text holds 4.5:1', () => {
    renderBell();
    const badge = within(screen.getByRole('button', { name: /unread/ })).getByText('3');
    expect(badge).toHaveClass('bg-error-600', 'text-white');
    expect(badge).not.toHaveClass('bg-error-500');
  });

  it('hangs the panel from the console header at its gutter where the row wraps', async () => {
    renderBell();
    await userEvent.click(screen.getByRole('button', { name: /unread/ }));
    const panel = screen.getByRole('dialog', { name: 'Notifications' });
    expect(panel.parentElement).toHaveClass('@max-[821px]/page:static');
    expect(panel).toHaveClass('w-96', '@max-[821px]/page:right-(--sd-header-gutter)');
  });
});
