/**
 * WorkspaceMenu — the console's module switcher (design handoff §7.3).
 *
 * Pins the panel's contract on its own: one row per workspace it is given,
 * the current one pressed, selection out through callbacks, and the dismissal
 * a popover owes its user — Escape, a press outside, Tab leaving it — with
 * focus back on the trigger. The per-workspace alarm slot renders BESIDE the
 * row button, never inside it (a preview chip is a button of its own).
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React, { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { definePreviewData, MockPreview } from '../../../../preview';
import { WorkspaceMenu, type WorkspaceMenuProps } from '../WorkspaceMenu';

import { WORKSPACES } from './railFixtures';

afterEach(cleanup);

/**
 * A preview chip in the alarm slot: the slot is the shell's to fill, and a
 * labelled preview (MockPreview, a button of its own) must keep working there.
 */
const ALARMS_PREVIEW = definePreviewData(
  {
    finding: 'TEST-LOW-001',
    // Any message key reads as the reason; the shell passes its own.
    reasonKey: 'common.noResults',
    needs: 'a per-workspace alarm source',
  },
  2,
);

type HarnessProps = Omit<WorkspaceMenuProps, 'triggerRef' | 'id'> & { open?: boolean };

function Harness({ open = true, ...props }: HarnessProps): React.ReactElement {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button type="button" ref={triggerRef}>
        open
      </button>
      <button type="button">elsewhere</button>
      {open && <WorkspaceMenu id="ws-menu" triggerRef={triggerRef} {...props} />}
    </div>
  );
}

function renderMenu(overrides: Partial<HarnessProps> = {}): HarnessProps {
  const props: HarnessProps = {
    workspaces: WORKSPACES,
    activeId: 'aqua',
    onSelect: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<Harness {...props} />);
  return props;
}

function menu(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Module' });
}

function row(name: string): HTMLElement {
  return within(menu()).getByRole('button', { name: new RegExp(name) });
}

describe('WorkspaceMenu', () => {
  it('lists every workspace given, with its description, the current one pressed', () => {
    renderMenu();
    expect(menu()).toHaveAttribute('id', 'ws-menu');
    expect(
      within(menu()).getByText(
        'The menu and colour follow the module. The alarm panel is shared by every module.',
      ),
    ).toBeInTheDocument();
    expect(row('Production')).toHaveAttribute('aria-pressed', 'true');
    expect(row('Greenhouse')).toHaveAttribute('aria-pressed', 'false');
    expect(row('Company')).toHaveAttribute('aria-pressed', 'false');
    // The fill alone is 1.03–1.14:1 against the paper (WCAG 1.4.11): the
    // current row carries a 3px accent bar on its right edge.
    const bar = 'shadow-[inset_-3px_0_0_var(--color-sd-accent)]';
    expect(row('Production').closest('li')).toHaveClass(bar);
    expect(row('Greenhouse').closest('li')).not.toHaveClass(bar);
    expect(row('Greenhouse')).toHaveTextContent(
      'Nutrient solution, greenhouse tools and greenhouse finance',
    );
  });

  it('moves focus to the current workspace on open', () => {
    renderMenu({ activeId: 'gh' });
    expect(row('Greenhouse')).toHaveFocus();
  });

  it('selects another workspace and closes', () => {
    const props = renderMenu();
    fireEvent.click(row('Company'));
    expect(props.onSelect).toHaveBeenCalledWith('org');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('only closes when the current workspace is chosen again', () => {
    const props = renderMenu();
    fireEvent.click(row('Production'));
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape without letting the key reach the page', () => {
    const props = renderMenu();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    fireEvent.keyDown(row('Production'), { key: 'Escape' });
    document.removeEventListener('keydown', outer);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('closes on a press outside, but not on its own trigger (the trigger toggles)', () => {
    const props = renderMenu();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'open' }));
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(row('Greenhouse'));
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when focus leaves it for the page', () => {
    const props = renderMenu();
    fireEvent.blur(row('Production'), {
      relatedTarget: screen.getByRole('button', { name: 'elsewhere' }),
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the trigger when it closes from inside', () => {
    const triggerProps: HarnessProps = {
      workspaces: WORKSPACES,
      activeId: 'aqua',
      onSelect: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = render(<Harness {...triggerProps} />);
    expect(row('Production')).toHaveFocus();
    // The host unmounts the menu on close.
    rerender(<Harness {...triggerProps} open={false} />);
    expect(screen.getByRole('button', { name: 'open' })).toHaveFocus();
  });

  it('leaves focus where the reader put it when it closes from outside', () => {
    const triggerProps: HarnessProps = {
      workspaces: WORKSPACES,
      activeId: 'aqua',
      onSelect: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = render(<Harness {...triggerProps} />);
    const elsewhere = screen.getByRole('button', { name: 'elsewhere' });
    elsewhere.focus();
    rerender(<Harness {...triggerProps} open={false} />);
    expect(elsewhere).toHaveFocus();
  });

  it('roves focus across the rows with the arrow keys, Home and End', () => {
    renderMenu();
    fireEvent.keyDown(row('Production'), { key: 'ArrowDown' });
    expect(row('Greenhouse')).toHaveFocus();
    fireEvent.keyDown(row('Greenhouse'), { key: 'End' });
    expect(row('Company')).toHaveFocus();
    fireEvent.keyDown(row('Company'), { key: 'ArrowDown' });
    expect(row('Production')).toHaveFocus();
    fireEvent.keyDown(row('Production'), { key: 'ArrowUp' });
    expect(row('Company')).toHaveFocus();
    fireEvent.keyDown(row('Company'), { key: 'Home' });
    expect(row('Production')).toHaveFocus();
  });

  it('renders each workspace’s alarm slot beside its row button, not inside it', () => {
    renderMenu({
      renderAlarms: (id) => (id === 'org' ? null : <button type="button">alarms {id}</button>),
    });
    const slot = within(menu()).getByRole('button', { name: 'alarms gh' });
    expect(row('Greenhouse')).not.toContainElement(slot);
    expect(row('Greenhouse').closest('li')).toContainElement(slot);
    expect(within(menu()).queryByRole('button', { name: 'alarms org' })).toBeNull();
  });

  it('closes a preview chip’s tooltip on Escape without closing the menu; the next Escape closes it', () => {
    const props = renderMenu({
      renderAlarms: (id) =>
        id === 'org' ? null : (
          <MockPreview data={ALARMS_PREVIEW} variant="inline">
            {(count) => <span>{count}</span>}
          </MockPreview>
        ),
    });
    const chip = within(row('Greenhouse').closest('li') ?? menu()).getByRole('button', {
      name: 'MOCK',
    });
    act(() => chip.focus());
    const tooltip = document.getElementById(chip.getAttribute('aria-describedby') ?? '');
    expect(tooltip).toBeVisible();

    fireEvent.keyDown(chip, { key: 'Escape' });
    expect(tooltip).not.toBeVisible();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(chip).toHaveFocus();

    fireEvent.keyDown(chip, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
