/**
 * UserMenu — the console's account control (README §7.4, §8).
 *
 * Trigger: the initials plate, the name and the role being shown (from a
 * console width of 980px), the language badge and a chevron. Panel (a
 * non-modal dialog on the shared Popover, so Escape and an outside press
 * close it and focus returns to the trigger): name and e-mail, the "view as
 * role" list when the shell passes one (admins), the language and theme
 * segments, the account links and sign out. The component decides nothing
 * itself: every choice goes back to the shell through a callback.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../../i18n';
import { UserMenu, type UserMenuProps } from '../UserMenu';

function props(overrides: Partial<UserMenuProps> = {}): UserMenuProps {
  return {
    name: 'Deniz Yılmaz',
    email: 'deniz@example.com',
    roleLabel: 'Tenant admin',
    theme: 'dark',
    onThemeChange: vi.fn(),
    onLocaleChange: vi.fn(),
    links: [
      { label: 'My Profile', onClick: vi.fn() },
      { label: 'Settings', onClick: vi.fn() },
    ],
    onSignOut: vi.fn(),
    ...overrides,
  };
}

async function open(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole('button', { name: 'User menu, Deniz Yılmaz' }));
  return screen.getByRole('dialog', { name: 'User menu' });
}

describe('UserMenu — trigger', () => {
  it('shows the initials, the name and role, and the language badge', () => {
    render(<UserMenu {...props()} />);
    const trigger = screen.getByRole('button', { name: 'User menu, Deniz Yılmaz' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(within(trigger).getByText('DY')).toBeInTheDocument();
    expect(within(trigger).getByText('Tenant admin')).toBeInTheDocument();
    expect(within(trigger).getByText('EN')).toBeInTheDocument();
  });

  it('shows name and role only from a console width of 980px', () => {
    render(<UserMenu {...props()} />);
    const nameAndRole = within(screen.getByRole('button', { name: /User menu/ }))
      .getByText('Tenant admin')
      .closest('span[class*="@min-[980px]/page:flex"]');
    expect(nameAndRole).not.toBeNull();
    expect(nameAndRole).toHaveClass('hidden');
  });

  // The header row cannot shrink the user menu, so an unbounded name pushed
  // the row past the console column (measured in Chromium: a 30-character
  // name overflowed by 92px at 1180px). The column is capped and both lines
  // truncate; the full name stays in the trigger's name and in the panel.
  it('caps the name and role column so a long name cannot widen the header row', () => {
    const name = 'Alexandria Montgomery-Smith Wellington';
    render(<UserMenu {...props({ name, roleLabel: 'Farm operations manager' })} />);
    const trigger = screen.getByRole('button', { name: `User menu, ${name}` });
    const role = within(trigger).getByText('Farm operations manager');
    const column = role.parentElement as HTMLElement;
    expect(column).toHaveClass('max-w-[180px]', 'min-w-0');
    expect(role).toHaveClass('truncate');
    expect(within(column).getByText(name)).toHaveClass('truncate');
  });
});

describe('UserMenu — panel placement', () => {
  // Where the header row wraps (console width ≤ 820px) the trigger can land
  // at the start of a second line, and a panel aligned to its right edge ran
  // off the console's left edge (Chromium: x -216..144 at 600px with a long
  // page title, under the rail at 800px). There the panel hangs from the
  // header instead — the Popover's box drops its positioning — at the
  // header's own gutter, and its width keeps that gutter on both sides.
  it('hangs the panel from the header at the row gutter where the row wraps', async () => {
    render(<UserMenu {...props()} />);
    const panel = await open();
    const popover = panel.parentElement as HTMLElement;
    // The Popover's `header-gutter` anchor, shared with the notification bell.
    expect(popover).toHaveClass('relative', '@max-[821px]/page:static');
    expect(panel).toHaveClass(
      'w-[360px]',
      '@max-[821px]/page:right-(--sd-header-gutter)',
      'max-w-[min(calc(100vw-1rem),calc(100cqw-2*var(--sd-header-gutter,0.5rem)))]',
    );
  });
});

describe('UserMenu — panel', () => {
  it('opens a named dialog with the identity, moves focus into it and closes on Escape', async () => {
    render(<UserMenu {...props()} />);
    const panel = await open();
    expect(within(panel).getByText('deniz@example.com')).toBeInTheDocument();
    expect(panel).toContainElement(document.activeElement as HTMLElement);

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /User menu/ })).toHaveFocus();
  });

  it('closes on a press outside it', async () => {
    render(
      <>
        <p>outside</p>
        <UserMenu {...props()} />
      </>,
    );
    await open();
    await userEvent.click(screen.getByText('outside'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('switches the language through the shell callback, the active one pressed', async () => {
    const onLocaleChange = vi.fn();
    render(<UserMenu {...props({ onLocaleChange })} />);
    const panel = await open();
    const group = within(panel).getByRole('group', { name: 'Language' });
    expect(within(group).getByRole('button', { name: 'English' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(within(group).getByRole('button', { name: 'Türkçe' }));
    expect(onLocaleChange).toHaveBeenCalledWith('tr');
  });

  it('switches the theme between Control room (dark) and Drawing (light)', async () => {
    const onThemeChange = vi.fn();
    render(<UserMenu {...props({ onThemeChange })} />);
    const panel = await open();
    const group = within(panel).getByRole('group', { name: 'Theme' });
    expect(within(group).getByRole('button', { name: 'Control room' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(group).getByRole('button', { name: 'Drawing' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await userEvent.click(within(group).getByRole('button', { name: 'Drawing' }));
    expect(onThemeChange).toHaveBeenCalledWith('light');
  });

  // The accent-100 fill is 1.03–1.14:1 against the paper (WCAG 1.4.11): the
  // chosen cell carries a 3px accent bar, the others none.
  it('marks the chosen segment with an accent bar, not by its tint alone', async () => {
    render(<UserMenu {...props()} />);
    const panel = await open();
    const group = within(panel).getByRole('group', { name: 'Theme' });
    const bar = 'shadow-[inset_0_-3px_0_var(--color-sd-accent)]';
    expect(within(group).getByRole('button', { name: 'Control room' })).toHaveClass(bar);
    expect(within(group).getByRole('button', { name: 'Drawing' })).not.toHaveClass(bar);
  });

  it('runs an account link and closes the panel', async () => {
    const profile = vi.fn();
    render(<UserMenu {...props({ links: [{ label: 'My Profile', onClick: profile }] })} />);
    const panel = await open();
    await userEvent.click(within(panel).getByRole('button', { name: 'My Profile' }));
    expect(profile).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('signs out', async () => {
    const onSignOut = vi.fn();
    render(<UserMenu {...props({ onSignOut })} />);
    const panel = await open();
    await userEvent.click(within(panel).getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});

describe('UserMenu — view as role', () => {
  const roles = [
    { id: 'r-admin', label: 'Tenant admin', pageCount: 41 },
    { id: 'r-op', label: 'Farm operator', pageCount: 1 },
  ];

  it('is absent unless the shell passes the role list (admins only)', async () => {
    render(<UserMenu {...props()} />);
    const panel = await open();
    expect(within(panel).queryByRole('group', { name: 'View as role' })).not.toBeInTheDocument();
  });

  it('lists the roles with their page counts, the shown one pressed, and reports a pick', async () => {
    const onViewAs = vi.fn();
    render(<UserMenu {...props({ viewAs: { roles, activeRoleId: 'r-admin', onViewAs } })} />);
    const panel = await open();
    const group = within(panel).getByRole('group', { name: 'View as role' });
    expect(group).toHaveAccessibleDescription(
      'The menu and pages follow the role; changes still run with your own.',
    );

    const admin = within(group).getByRole('button', { name: /Tenant admin/ });
    const operator = within(group).getByRole('button', { name: /Farm operator/ });
    expect(admin).toHaveAttribute('aria-pressed', 'true');
    expect(operator).toHaveAttribute('aria-pressed', 'false');
    expect(admin).toHaveTextContent('41 pages');
    expect(operator).toHaveTextContent('1 page');
    // The empty radio ring holds 3:1 on the paper (neutral-500 was 2.57:1 in Drawing).
    expect(operator.firstElementChild).toHaveClass('border-sd-neutral-600');

    await userEvent.click(operator);
    expect(onViewAs).toHaveBeenCalledWith('r-op');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('UserMenu — Turkish', () => {
  it('speaks the active locale', async () => {
    render(
      <I18nProvider locale="tr">
        <UserMenu {...props()} />
      </I18nProvider>,
    );
    const trigger = screen.getByRole('button', { name: 'Kullanıcı menüsü, Deniz Yılmaz' });
    expect(within(trigger).getByText('TR')).toBeInTheDocument();
    await userEvent.click(trigger);
    const panel = screen.getByRole('dialog', { name: 'Kullanıcı menüsü' });
    expect(within(panel).getByRole('group', { name: 'Tema' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Kontrol odası' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Çizim' })).toBeInTheDocument();
  });
});
