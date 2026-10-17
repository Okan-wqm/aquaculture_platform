/**
 * NotificationToggle — a switch row of the settings page's notification card.
 *
 * It was declared inside PreferencesTab's render, so every toggle (which sets
 * the tab's state) made it a new component type: React unmounted the button
 * and mounted a fresh one, and a keyboard user lost focus after each Space or
 * Enter. It was also a bare button — no switch role, no checked state, its
 * visible label not tied to it (WCAG 2.4.3, 4.1.2). These specs pin the
 * module-scope switch: named by its label, reporting its state, keeping focus
 * through a toggle in a parent that re-renders.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { NotificationToggle } from '../NotificationToggle';

/** A parent whose state the switch writes — what PreferencesTab does. */
function Preferences(): React.ReactElement {
  const [prefs, setPrefs] = useState({ email: false, sms: true });
  return (
    <div>
      <NotificationToggle
        enabled={prefs.email}
        onChange={(email) => setPrefs((current) => ({ ...current, email }))}
        label="Email"
        desc="Alerts by email"
      />
      <NotificationToggle
        enabled={prefs.sms}
        onChange={(sms) => setPrefs((current) => ({ ...current, sms }))}
        label="SMS"
        desc="Critical alerts by SMS"
      />
    </div>
  );
}

describe('NotificationToggle', () => {
  it('is a switch named by its visible label, reporting its state', () => {
    render(<Preferences />);

    expect(screen.getByRole('switch', { name: 'Email' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'SMS' })).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps keyboard focus on the same switch through a toggle that re-renders the parent', async () => {
    const user = userEvent.setup();
    render(<Preferences />);

    const email = screen.getByRole('switch', { name: 'Email' });
    email.focus();
    await user.keyboard(' ');
    expect(screen.getByRole('switch', { name: 'Email' })).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(email);

    await user.keyboard('{Enter}');
    expect(email).toHaveAttribute('aria-checked', 'false');
    expect(document.activeElement).toBe(email);
  });

  it('draws its focus ring for keyboard focus only', () => {
    render(<Preferences />);

    const sms = screen.getByRole('switch', { name: 'SMS' });
    expect(sms).toHaveClass('focus-visible:ring-2', 'focus-visible:ring-primary-500');
    expect(sms.className).not.toMatch(/(?<![\w-])focus:ring-2/);
  });
});
