/**
 * TenantSettings — the section nav announces and marks the section shown.
 *
 * The nav buttons carried the selection in hue only: in the Company
 * workspace (slate accent) the active label sat 1.35:1 from an inactive one
 * and the active fill 1.04:1 from the card, and no state reached a screen
 * reader (WCAG 1.4.1, 4.1.2). Each section is now a SelectableRow: the shown
 * one is `aria-current="page"` and carries the accent line; moving to another
 * section moves both.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

// The real Button: SelectableRow renders each section through its row layout.
vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return {
    Button: actual.Button,
    PageHeader: actual.PageHeader,
    useI18n: actual.useI18n,
    useAuthContext: () => ({ hasRoleOrHigher: () => true }),
  };
});

// Each section loads its own data; the nav is what is under test here.
vi.mock('../../components/settings', () => ({
  GeneralSettings: () => <div>general-section</div>,
  NotificationSettings: () => <div>notifications-section</div>,
  SecuritySettings: () => <div>security-section</div>,
  LocalizationSettings: () => <div>localization-section</div>,
  MobileSettings: () => <div>mobile-section</div>,
  AiAssistantSettings: () => <div>ai-section</div>,
}));

import TenantSettings from '../TenantSettings';

function section(name: RegExp): HTMLElement {
  return screen.getByRole('button', { name });
}

describe('TenantSettings section nav', () => {
  it('announces the section shown as the current page and marks it with the accent line', () => {
    render(<TenantSettings />);

    expect(section(/^General/)).toHaveAttribute('aria-current', 'page');
    expect(section(/^General/)).toHaveClass('border-l-primary-600');
    expect(section(/^Security/)).not.toHaveAttribute('aria-current');
    expect(section(/^Security/)).toHaveClass('border-l-transparent');
    expect(screen.getByText('general-section')).toBeInTheDocument();
  });

  it('moves the current page with the keyboard', async () => {
    const user = userEvent.setup();
    render(<TenantSettings />);

    section(/^Security/).focus();
    await user.keyboard('{Enter}');

    expect(section(/^Security/)).toHaveAttribute('aria-current', 'page');
    expect(section(/^General/)).not.toHaveAttribute('aria-current');
    expect(screen.getByText('security-section')).toBeInTheDocument();
  });
});
