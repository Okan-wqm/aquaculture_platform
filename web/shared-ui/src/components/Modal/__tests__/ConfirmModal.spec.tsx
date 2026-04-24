/**
 * ConfirmModal — extended surface tests
 *
 * Pins three behaviours added in Scope C PR-0a:
 *   1. `message` accepts ReactNode (not just string)
 *   2. `requireTypedConfirmation` gates the confirm button until the
 *      user types the expected text
 *   3. Typed-confirmation text resets when the modal re-opens
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ConfirmModal } from '../Modal';

describe('ConfirmModal — message accepts ReactNode', () => {
  it('renders a plain string message', () => {
    render(
      <ConfirmModal
        isOpen
        onClose={() => {}}
        onConfirm={() => {}}
        title="Onay"
        message="Düz metin mesaj"
      />,
    );
    expect(screen.queryByText('Düz metin mesaj')).not.toBeNull();
  });

  it('renders a JSX message with inner formatting', () => {
    render(
      <ConfirmModal
        isOpen
        onClose={() => {}}
        onConfirm={() => {}}
        title="Onay"
        message={
          <span>
            <strong data-testid="emph">12</strong> satır silinecek
          </span>
        }
      />,
    );
    expect(screen.getByTestId('emph').textContent).toBe('12');
    expect(screen.queryByText(/satır silinecek/)).not.toBeNull();
  });
});

describe('ConfirmModal — requireTypedConfirmation gate', () => {
  it('disables confirm button until the required text is typed', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmModal
        isOpen
        onClose={() => {}}
        onConfirm={onConfirm}
        title="Toplu üretim"
        message="Gerçekten üretmek istediğinize emin misiniz?"
        confirmText="Üret"
        requireTypedConfirmation="ONAYLIYORUM"
      />,
    );

    const confirmButton = screen.getByRole('button', { name: 'Üret' }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);

    // Type wrong text — still disabled.
    const input = screen.getByLabelText('Typed confirmation');
    fireEvent.change(input, { target: { value: 'Evet' } });
    expect(confirmButton.disabled).toBe(true);

    // Type correct text — enabled.
    fireEvent.change(input, { target: { value: 'ONAYLIYORUM' } });
    expect(confirmButton.disabled).toBe(false);

    // Confirm fires.
    fireEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('tolerates leading/trailing whitespace on the typed confirmation', () => {
    render(
      <ConfirmModal
        isOpen
        onClose={() => {}}
        onConfirm={() => {}}
        title="x"
        message="x"
        requireTypedConfirmation="KABUL"
      />,
    );
    const input = screen.getByLabelText('Typed confirmation');
    fireEvent.change(input, { target: { value: '  KABUL  ' } });
    const confirmButton = screen.getByRole('button', {
      name: 'Onayla',
    }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(false);
  });

  it('leaves confirm enabled when no typed-confirmation prop provided (legacy behaviour)', () => {
    render(
      <ConfirmModal
        isOpen
        onClose={() => {}}
        onConfirm={() => {}}
        title="Normal onay"
        message="Sil?"
        confirmText="Sil"
      />,
    );
    const btn = screen.getByRole('button', { name: 'Sil' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(screen.queryByLabelText('Typed confirmation')).toBeNull();
  });

  it('resets typed confirmation across open/close/open cycles', () => {
    function Harness() {
      const [open, setOpen] = React.useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            re-open
          </button>
          <ConfirmModal
            isOpen={open}
            onClose={() => setOpen(false)}
            onConfirm={() => {}}
            title="t"
            message="m"
            requireTypedConfirmation="RESET"
            confirmText="Do"
          />
        </>
      );
    }
    render(<Harness />);
    let input = screen.getByLabelText('Typed confirmation');
    fireEvent.change(input, { target: { value: 'RESET' } });
    expect(
      (screen.getByRole('button', { name: 'Do' }) as HTMLButtonElement).disabled,
    ).toBe(false);

    // Close then re-open.
    fireEvent.click(screen.getByText('İptal'));
    fireEvent.click(screen.getByText('re-open'));

    input = screen.getByLabelText('Typed confirmation');
    expect((input as HTMLInputElement).value).toBe('');
    expect(
      (screen.getByRole('button', { name: 'Do' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
