/**
 * Modal — colour scheme and stacking (FE-MEDIUM-072, FE-HIGH-065).
 *
 * Pins that `theme="dark"` marks the dialog root with the attribute theme.css
 * keys `dark:` on, that two open dialogs label themselves apart, and that
 * Escape and the scroll lock follow the dialog stack rather than each dialog
 * on its own.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { Modal } from '../Modal';

afterEach(cleanup);

describe('Modal — theme', () => {
  it('follows the shell by default: no data-theme on the dialog root', () => {
    render(
      <Modal isOpen onClose={() => {}} title="Ayarlar">
        <p>içerik</p>
      </Modal>,
    );
    expect(screen.getByRole('dialog').getAttribute('data-theme')).toBeNull();
  });

  it('pins data-theme="dark" on the root for theme="dark", so every dark: class inside fires whatever the shell shows', () => {
    render(
      <Modal isOpen onClose={() => {}} theme="dark" title="Export">
        <p>içerik</p>
      </Modal>,
    );
    expect(screen.getByRole('dialog').getAttribute('data-theme')).toBe('dark');
  });

  it('names its close button as asked', () => {
    render(
      <Modal isOpen onClose={() => {}} title="Editör" closeLabel="Editörü kapat">
        <p>içerik</p>
      </Modal>,
    );
    expect(screen.getByLabelText('Editörü kapat')).toBeTruthy();
  });
});

describe('Modal — stacking', () => {
  it('labels two open dialogs apart', () => {
    render(
      <>
        <Modal isOpen onClose={() => {}} title="Dış" description="dış açıklama">
          <p>a</p>
        </Modal>
        <Modal isOpen onClose={() => {}} title="İç" description="iç açıklama">
          <p>b</p>
        </Modal>
      </>,
    );
    expect(screen.getByRole('dialog', { name: 'Dış', description: 'dış açıklama' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'İç', description: 'iç açıklama' })).toBeTruthy();
  });

  it('Escape closes only the dialog on top; the one beneath answers once it is on top again', () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    const { rerender } = render(
      <>
        <Modal isOpen onClose={closeOuter} title="Dış">
          <p>a</p>
        </Modal>
        <Modal isOpen onClose={closeInner} title="İç">
          <p>b</p>
        </Modal>
      </>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();

    rerender(
      <>
        <Modal isOpen onClose={closeOuter} title="Dış">
          <p>a</p>
        </Modal>
        <Modal isOpen={false} onClose={closeInner} title="İç">
          <p>b</p>
        </Modal>
      </>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closeOuter).toHaveBeenCalledTimes(1);
    expect(closeInner).toHaveBeenCalledTimes(1);
  });

  it('keeps the body scroll locked until the last dialog closes', () => {
    const tree = (outer: boolean, inner: boolean): React.ReactElement => (
      <>
        <Modal isOpen={outer} onClose={() => {}} title="Dış">
          <p>a</p>
        </Modal>
        <Modal isOpen={inner} onClose={() => {}} title="İç">
          <p>b</p>
        </Modal>
      </>
    );
    const { rerender } = render(tree(true, true));
    expect(document.body.style.overflow).toBe('hidden');
    rerender(tree(true, false));
    expect(document.body.style.overflow).toBe('hidden');
    rerender(tree(false, false));
    expect(document.body.style.overflow).toBe('');
  });
});

describe('Modal — focus return (FE-HIGH-087)', () => {
  const Host: React.FC<{ open: boolean; mounted: boolean }> = ({ open, mounted }) => (
    <>
      <button type="button">opener</button>
      {mounted && (
        <Modal isOpen={open} onClose={() => {}} title="Düzenle">
          <input aria-label="ad" />
        </Modal>
      )}
    </>
  );

  it('returns focus to the opener when the dialog unmounts while open (a wrapper that early-returns null)', () => {
    vi.useFakeTimers();
    const { rerender } = render(<Host open={false} mounted={false} />);
    const opener = screen.getByRole('button', { name: 'opener' });
    opener.focus();
    expect(document.activeElement).toBe(opener);

    rerender(<Host open mounted />);
    vi.runAllTimers();
    expect(document.activeElement).not.toBe(opener);

    rerender(<Host open={false} mounted={false} />);
    expect(document.activeElement).toBe(opener);
    vi.useRealTimers();
  });
});
