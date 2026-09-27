/**
 * BottomSheet — dialog semantics every AquaMobil sheet now inherits
 * (FE-HIGH-065, batch 5). These pin the four behaviours the hand-rolled
 * copies each dropped one of: Escape, focus in/trap/restore, scroll lock and a
 * labelled, inert-while-busy dismissal.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { BottomSheet } from '../BottomSheet';

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

function Host({ initiallyOpen = true }: { initiallyOpen?: boolean }): ReactElement {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open sheet
      </button>
      <BottomSheet isOpen={open} onClose={() => setOpen(false)} title="Share">
        <button type="button">first action</button>
        <button type="button">second action</button>
      </BottomSheet>
    </>
  );
}

describe('BottomSheet', () => {
  it('renders nothing while closed', () => {
    render(
      <BottomSheet isOpen={false} onClose={vi.fn()} title="Share">
        <p>body</p>
      </BottomSheet>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is a modal dialog named by its title', () => {
    render(
      <BottomSheet isOpen onClose={vi.fn()} title="Share" description="Pick a source">
        <p>body</p>
      </BottomSheet>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Share' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('Pick a source')).toBeTruthy();
  });

  it('closes on Escape, on the backdrop and on the labelled close control', () => {
    const onClose = vi.fn();
    render(
      <BottomSheet isOpen onClose={onClose} title="Share" closeLabel="Close share sheet">
        <p>body</p>
      </BottomSheet>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Close share sheet' }));
    expect(onClose).toHaveBeenCalledTimes(2);

    const dialog = screen.getByRole('dialog');
    const backdrop = dialog.previousElementSibling;
    if (!(backdrop instanceof HTMLElement)) throw new Error('backdrop not rendered');
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('is inert while busy: no Escape, backdrop or close-control dismissal', () => {
    const onClose = vi.fn();
    render(
      <BottomSheet isOpen onClose={onClose} title="Forward" isBusy>
        <p>body</p>
      </BottomSheet>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveProperty('disabled', true);
    fireEvent.click(close);
    const backdrop = screen.getByRole('dialog').previousElementSibling;
    if (!(backdrop instanceof HTMLElement)) throw new Error('backdrop not rendered');
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true');
  });

  it('moves focus into the sheet, traps Tab inside it and restores focus on close', () => {
    render(<Host initiallyOpen={false} />);
    const opener = screen.getByRole('button', { name: 'open sheet' });
    opener.focus();
    fireEvent.click(opener);

    const first = screen.getByRole('button', { name: 'first action' });
    const second = screen.getByRole('button', { name: 'second action' });
    // The header's close control is the first focusable in DOM order; the
    // last body action is the last.
    const close = screen.getByRole('button', { name: 'Close' });
    expect(document.activeElement).toBe(close);

    second.focus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    close.focus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(second);
    expect(first.isConnected).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('locks page scroll while open and releases it on close', () => {
    render(<Host />);
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.body.style.overflow).toBe('');
  });
});
