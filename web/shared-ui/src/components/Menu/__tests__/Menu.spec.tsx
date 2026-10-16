import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Menu } from '../Menu';
import { Popover } from '../Popover';

const items = (onProfile: () => void, onLogout: () => void) => [
  { id: 'profile', label: 'Profile', onSelect: onProfile },
  { id: 'logout', label: 'Sign out', onSelect: onLogout, danger: true, separator: true },
];

describe('Menu', () => {
  it('opens from its trigger, moves with the arrows, selects and closes, and Escape returns focus', () => {
    const onProfile = vi.fn();
    const onLogout = vi.fn();
    render(
      <Menu
        aria-label="User menu"
        items={items(onProfile, onLogout)}
        trigger={(p) => <button {...p}>Account</button>}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Account' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'User menu' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Profile' }));

    // Keys come from the focused item and bubble up, as they do in a browser.
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Sign out' }));
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Profile' }));

    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on a click outside', () => {
    render(
      <>
        <p>outside</p>
        <Menu
          aria-label="User menu"
          items={items(
            () => {},
            () => {},
          )}
          trigger={(p) => <button {...p}>Account</button>}
        />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.mouseDown(screen.getByText('outside'));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('Popover', () => {
  it('is a named dialog anchored to its trigger, capped to the viewport', () => {
    render(
      <Popover aria-label="Notifications" trigger={(p) => <button {...p}>Bell</button>}>
        <p>3 unread</p>
      </Popover>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Bell' }));
    const panel = screen.getByRole('dialog', { name: 'Notifications' });
    expect(panel.className).toContain('max-w-[calc(100vw-1rem)]');
    expect(panel.textContent).toContain('3 unread');
  });

  it('paints the console surface instead of the card when asked, keeping the behaviour', () => {
    render(
      <Popover aria-label="Account" surface="console" trigger={(p) => <button {...p}>Me</button>}>
        <button type="button">Sign out</button>
      </Popover>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Me' }));
    const panel = screen.getByRole('dialog', { name: 'Account' });
    expect(panel).toHaveClass('bg-sd-paper', 'border-sd-rule', 'shadow-(--shadow-sd-lg)');
    expect(panel).not.toHaveClass('bg-white');
    expect(panel).not.toHaveClass('rounded-lg');
    expect(panel.className).toContain('max-w-[calc(100vw-1rem)]');
    expect(screen.getByRole('button', { name: 'Sign out' })).toHaveFocus();
  });
});

describe('Popover — focus leaving and the console header anchor', () => {
  function renderWithNeighbour(): void {
    render(
      <>
        <Popover aria-label="Account" trigger={(p) => <button {...p}>Me</button>}>
          <button type="button">Profile</button>
          <button type="button">Sign out</button>
        </Popover>
        <button type="button">Next control</button>
      </>,
    );
  }

  // The panel would otherwise cover the control Tab lands on (WCAG 2.4.11).
  it('closes when focus leaves it for the page and leaves focus there', async () => {
    const user = userEvent.setup();
    renderWithNeighbour();
    await user.click(screen.getByRole('button', { name: 'Me' }));
    expect(screen.getByRole('button', { name: 'Profile' })).toHaveFocus();

    await user.tab();
    await user.tab();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Next control' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Me' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('stays open while focus moves between its trigger and its panel', async () => {
    const user = userEvent.setup();
    renderWithNeighbour();
    await user.click(screen.getByRole('button', { name: 'Me' }));
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Me' })).toHaveFocus();
    expect(screen.getByRole('dialog', { name: 'Account' })).toBeInTheDocument();
  });

  it('still hands focus back to the trigger when it closes from inside', async () => {
    const user = userEvent.setup();
    renderWithNeighbour();
    await user.click(screen.getByRole('button', { name: 'Me' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Me' })).toHaveFocus();
  });

  // Where the console header row wraps, a panel on the trigger's edge ran off
  // the console's side; it hangs from the header at the row gutter instead.
  it('hangs from the console header at its gutter where the header row wraps', () => {
    render(
      <Popover
        aria-label="Notifications"
        anchor="header-gutter"
        panelClassName="w-96"
        trigger={(p) => <button {...p}>Bell</button>}
      >
        <p>3 unread</p>
      </Popover>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Bell' }));
    const panel = screen.getByRole('dialog', { name: 'Notifications' });
    const root = panel.parentElement as HTMLElement;
    expect(root).toHaveClass('relative', '@max-[821px]/page:static');
    expect(panel).toHaveClass(
      'w-96',
      'right-0',
      '@max-[821px]/page:right-(--sd-header-gutter)',
      'max-w-[min(calc(100vw-1rem),calc(100cqw-2*var(--sd-header-gutter,0.5rem)))]',
    );
    expect(panel).not.toHaveClass('max-w-[calc(100vw-1rem)]');
  });

  it('anchors to the trigger by default', () => {
    render(
      <Popover aria-label="Notifications" trigger={(p) => <button {...p}>Bell</button>}>
        <p>3 unread</p>
      </Popover>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Bell' }));
    const panel = screen.getByRole('dialog', { name: 'Notifications' });
    expect(panel.parentElement).not.toHaveClass('@max-[821px]/page:static');
    expect(panel).not.toHaveClass('@max-[821px]/page:right-(--sd-header-gutter)');
  });
});
