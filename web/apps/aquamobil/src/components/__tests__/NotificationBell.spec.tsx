// FE-LOW-051 — a failed unread-count fetch must not render as a confident "0".
//
// useNotifications deliberately exposes `isCountError` alongside the numeric
// `unreadCount` (which keeps its `?? 0` success default) so the bell can tell
// "all caught up" apart from "the count is unavailable". The bell previously
// ignored that flag: a gateway outage read as zero unread — exactly the wrong
// signal for a field operator relying on the bell for pending alerts.

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { NotificationBell } from '../NotificationBell';

const mockUseNotifications = vi.fn();
vi.mock('@/hooks/useNotifications', () => ({
  useNotifications: (): unknown => mockUseNotifications(),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: (): unknown => mockNavigate };
});

function bellState(overrides: Partial<{ unreadCount: number; isCountError: boolean }>): void {
  mockUseNotifications.mockReturnValue({
    unreadCount: 0,
    isCountError: false,
    ...overrides,
  });
}

function renderBell(): void {
  render(
    <MemoryRouter>
      <NotificationBell />
    </MemoryRouter>,
  );
}

describe('NotificationBell (FE-LOW-051)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('shows the unread count badge on the success path', () => {
    bellState({ unreadCount: 7 });
    renderBell();

    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Notifications, 7 unread' })).toBeTruthy();
  });

  it('caps the badge at 99+', () => {
    bellState({ unreadCount: 120 });
    renderBell();

    expect(screen.getByText('99+')).toBeTruthy();
  });

  it('renders no badge when there are truly zero unread', () => {
    bellState({ unreadCount: 0 });
    renderBell();

    expect(screen.queryByText('0')).toBeNull();
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy();
  });

  it('renders an "unavailable" affordance — never "0" — when the count fetch failed', () => {
    bellState({ unreadCount: 0, isCountError: true });
    renderBell();

    // Not a numeric badge: a neutral indicator plus an aria-label that says the
    // count is unavailable, so assistive tech gets the same signal.
    expect(screen.queryByText('0')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Notifications, unread count unavailable' }),
    ).toBeTruthy();
    expect(screen.getByText('!')).toBeTruthy();
  });

  it('error affordance wins even if a stale numeric count is present', () => {
    bellState({ unreadCount: 5, isCountError: true });
    renderBell();

    expect(screen.queryByText('5')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Notifications, unread count unavailable' }),
    ).toBeTruthy();
  });

  it('navigates to /notifications on tap in every state', () => {
    bellState({ isCountError: true });
    renderBell();

    fireEvent.click(screen.getByRole('button', { name: /Notifications/ }));
    expect(mockNavigate).toHaveBeenCalledWith('/notifications');
  });
});
