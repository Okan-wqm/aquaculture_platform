/**
 * PasswordInput — show/hide toggle, caps-lock warning, a11y, surface passthrough
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, createEvent } from '@testing-library/react';

import { PasswordInput } from '../PasswordInput';

/**
 * Dispatch a keydown/keyup whose native event reports a specific CapsLock state.
 * `fireEvent`'s init does not reliably reach React's synthetic `getModifierState`,
 * so we define it directly on the native event before dispatching.
 */
function fireKeyWithCaps(
  el: HTMLElement,
  type: 'keyDown' | 'keyUp',
  capsOn: boolean,
): void {
  const ev = createEvent[type](el, { key: 'a' });
  Object.defineProperty(ev, 'getModifierState', { value: () => capsOn });
  fireEvent(el, ev);
}

describe('PasswordInput show/hide toggle', () => {
  it('starts hidden and toggles to text and back', () => {
    render(<PasswordInput label="Şifre" />);
    const input = screen.getByLabelText('Şifre');
    expect(input.getAttribute('type')).toBe('password');

    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    // toggle is bound to its field so two PasswordInputs on one form are distinguishable
    expect(toggle.getAttribute('aria-controls')).toBe(input.id);

    fireEvent.click(toggle);
    expect(input.getAttribute('type')).toBe('text');
    expect(screen.getByRole('button', { name: 'Hide password' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(input.getAttribute('type')).toBe('password');
  });

  it('honors localized toggle labels', () => {
    render(
      <PasswordInput label="Şifre" showPasswordLabel="Şifreyi göster" hidePasswordLabel="Şifreyi gizle" />,
    );
    expect(screen.getByRole('button', { name: 'Şifreyi göster' })).not.toBeNull();
  });
});

describe('PasswordInput caps-lock warning', () => {
  it('shows a polite status when Caps Lock is on and links it via aria-describedby', () => {
    render(<PasswordInput label="Şifre" capsLockLabel="Caps Lock açık" />);
    const input = screen.getByLabelText('Şifre');

    fireKeyWithCaps(input, 'keyDown', true);
    const warning = screen.getByRole('status');
    expect(warning.textContent).toBe('Caps Lock açık');
    expect(warning.getAttribute('aria-live')).toBe('polite');
    expect(input.getAttribute('aria-describedby') || '').toContain(warning.id);

    fireKeyWithCaps(input, 'keyUp', false);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('PasswordInput surface passthrough', () => {
  it('forwards surface="glass" to the underlying input', () => {
    render(<PasswordInput surface="glass" label="Şifre" />);
    const input = screen.getByLabelText('Şifre');
    expect(input.className).toContain('bg-[var(--surface-field-bg)]');
  });
});
