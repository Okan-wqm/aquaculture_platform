/**
 * AuthFormShell — i18n heading + single error region + contrast-token guard.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '@aquaculture/shared-ui';

import { AuthFormShell } from '../AuthFormShell';

const renderEn = (ui: React.ReactNode): ReturnType<typeof render> =>
  render(<I18nProvider locale="en">{ui}</I18nProvider>);

describe('AuthFormShell', () => {
  it('renders the i18n title + subtitle', () => {
    renderEn(
      <AuthFormShell titleKey="login.title" subtitleKey="login.subtitle">
        <div>fields</div>
      </AuthFormShell>,
    );
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Sign In');
    expect(screen.getByText('Access your account')).toBeTruthy();
  });

  it('routes the error into one aria-live region and omits it when absent', () => {
    const { container, rerender } = renderEn(
      <AuthFormShell titleKey="login.title" error="Bad credentials">
        <div />
      </AuthFormShell>,
    );
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(screen.getByText('Bad credentials')).toBeTruthy();

    rerender(
      <I18nProvider locale="en">
        <AuthFormShell titleKey="login.title">
          <div />
        </AuthFormShell>
      </I18nProvider>,
    );
    expect(screen.queryByText('Bad credentials')).toBeNull();
  });

  it('heading uses the glass token — never text-white or raw blue-*', () => {
    renderEn(
      <AuthFormShell titleKey="login.title">
        <div />
      </AuthFormShell>,
    );
    const h2 = screen.getByRole('heading', { level: 2 });
    expect(h2.className).toContain('text-[var(--surface-heading-fg)]');
    expect(h2.className).not.toContain('text-white');
    expect(h2.className).not.toMatch(/text-blue-/);
  });
});
