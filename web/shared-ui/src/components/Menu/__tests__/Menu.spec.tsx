import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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
});
