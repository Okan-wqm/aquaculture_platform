/**
 * Sheet specs — the modal contract a hand-rolled overlay always forgets.
 *
 * The pre-v4 app had three separate hand-rolled overlays (the install prompt,
 * the account confirm dialog, the messaging ConfirmDialog) and none of them
 * trapped focus or restored it. Now that one component owns every sheet in the
 * app, these specs are what stop that regressing again.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { Sheet } from '../Sheet';

afterEach(cleanup);

describe('Sheet', () => {
  it('renders nothing while closed', () => {
    render(
      <Sheet open={false} onClose={vi.fn()} title="Record mortality">
        <button type="button">inside</button>
      </Sheet>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('exposes a labelled modal dialog', () => {
    render(
      <Sheet open onClose={vi.fn()} title="Record mortality">
        <button type="button">inside</button>
      </Sheet>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Record mortality' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="Record mortality">
        <button type="button">inside</button>
      </Sheet>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes when the backdrop is activated', () => {
    // The scrim is a real <button>, so it is keyboard-operable rather than a
    // click-only <div> — the mistake the pre-v4 overlays all made. It is named
    // 'Dismiss' so it does not collide with the header's 'Close'.
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="Record mortality">
        <button type="button">inside</button>
      </Sheet>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('locks the page behind it and releases on close', () => {
    const { rerender } = render(
      <Sheet open onClose={vi.fn()} title="Record mortality">
        <button type="button">inside</button>
      </Sheet>,
    );
    expect(document.body.style.overflow).toBe('hidden');

    rerender(
      <Sheet open={false} onClose={vi.fn()} title="Record mortality">
        <button type="button">inside</button>
      </Sheet>,
    );
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('moves focus into the sheet on open and returns it to the opener on close', () => {
    // Focus restoration is what keeps a keyboard or screen-reader user from
    // being dumped at the top of the page every time they log an entry.
    const opener = document.createElement('button');
    opener.textContent = 'Log entry';
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { rerender } = render(
      <Sheet open onClose={vi.fn()} title="Record mortality">
        <button type="button">inside</button>
      </Sheet>,
    );
    expect(document.body.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(opener);

    rerender(
      <Sheet open={false} onClose={vi.fn()} title="Record mortality">
        <button type="button">inside</button>
      </Sheet>,
    );
    expect(document.activeElement).toBe(opener);

    opener.remove();
  });

  it('renders the footer so the commit action is pinned outside the scroll area', () => {
    render(
      <Sheet
        open
        onClose={vi.fn()}
        title="Record mortality"
        footer={<button type="button">Save</button>}
      >
        <button type="button">inside</button>
      </Sheet>,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});
