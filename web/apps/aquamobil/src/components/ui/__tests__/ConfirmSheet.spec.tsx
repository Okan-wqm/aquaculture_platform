/**
 * ConfirmSheet — the one confirmation surface (FE-HIGH-065, batch 5). Pins
 * the union of what the two deleted ConfirmDialog copies did: confirm/cancel,
 * an inline error slot, and an async confirm that keeps the sheet inert until
 * it settles (MT-MEDIUM-050).
 */
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { ConfirmSheet } from '../ConfirmSheet';

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

describe('ConfirmSheet', () => {
  it('runs the action on confirm and cancels on cancel', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmSheet
        isOpen
        title="Leave Channel"
        message="You will no longer receive messages."
        confirmLabel="Leave"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Leave Channel' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('surfaces the caller-provided error inside the sheet', () => {
    render(
      <ConfirmSheet
        isOpen
        title="Log Out"
        message="Are you sure?"
        confirmLabel="Log Out"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        errorMessage="Device wipe failed"
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe('Device wipe failed');
  });

  it('stays inert while an async confirm is pending and recovers when it settles', async () => {
    let settle: () => void = () => undefined;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const onCancel = vi.fn();
    render(
      <ConfirmSheet
        isOpen
        title="Clear Offline Queue"
        message="Clearing will permanently delete them."
        confirmLabel="Clear Queue"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Clear Queue' });
    fireEvent.click(confirm);
    expect(confirm).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();

    await act(async () => {
      settle();
      await Promise.resolve();
    });
    expect(confirm).toHaveProperty('disabled', false);
  });
});
