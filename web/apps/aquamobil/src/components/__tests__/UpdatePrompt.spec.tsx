// The service-worker "new version" prompt used to be a browser confirm() fired
// from outside React. It is now an in-app banner driven by the
// update-available store, so it is stylable, dark-mode aware and non-blocking.

import { render, screen, cleanup, act } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';

import { UpdatePrompt } from '../UpdatePrompt';

import { announceUpdate, dismissUpdate } from '@/pwa/update-available';

describe('UpdatePrompt', () => {
  afterEach(() => {
    cleanup();
    dismissUpdate();
  });

  it('renders nothing until an update is announced', () => {
    render(<UpdatePrompt />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the banner and applies the update on Reload', () => {
    const apply = vi.fn();
    render(<UpdatePrompt />);

    act(() => {
      announceUpdate(apply);
    });

    expect(screen.getByRole('status').textContent).toContain('New version available');
    screen.getByRole('button', { name: 'Reload now' }).click();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('dismiss hides the banner without applying', () => {
    const apply = vi.fn();
    render(<UpdatePrompt />);
    act(() => {
      announceUpdate(apply);
    });

    act(() => {
      screen.getByRole('button', { name: 'Dismiss update notice' }).click();
    });

    expect(screen.queryByRole('status')).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });
});
