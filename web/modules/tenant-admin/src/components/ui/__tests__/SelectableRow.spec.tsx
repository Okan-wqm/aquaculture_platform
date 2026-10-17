/**
 * SelectableRow — the row of a master-detail list or a section nav.
 *
 * The rows it replaces were `<div onClick>`: no role, no tab stop, no key
 * handler, and the selected one marked by a fill that is 1.04:1 against the
 * cream list in the Company workspace (slate accent). These specs pin what the
 * row now guarantees by construction: a keyboard user reaches and opens it,
 * the selection is announced (`aria-current`), and the selected row carries a
 * mark that is not hue alone — the accent line, or the inset frame on a row
 * whose left edge already means something else.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SelectableRow } from '../SelectableRow';

describe('SelectableRow', () => {
  it('is a button a keyboard user reaches and opens with Enter or Space', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SelectableRow current={false} onSelect={onSelect}>
        Billing question
      </SelectableRow>,
    );

    const row = screen.getByRole('button', { name: 'Billing question' });
    expect(row).toHaveAttribute('type', 'button');
    await user.tab();
    expect(row).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('announces the selected row as the current item, and no other', () => {
    render(
      <>
        <SelectableRow current onSelect={vi.fn()}>
          First
        </SelectableRow>
        <SelectableRow current={false} onSelect={vi.fn()}>
          Second
        </SelectableRow>
      </>,
    );

    expect(screen.getByRole('button', { name: 'First' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Second' })).not.toHaveAttribute('aria-current');
  });

  it('names a section nav entry the current page when asked', () => {
    render(
      <SelectableRow current currentKind="page" onSelect={vi.fn()}>
        General
      </SelectableRow>,
    );

    expect(screen.getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page');
  });

  it('marks the selected row with the accent line, reserved on every row so nothing shifts', () => {
    render(
      <>
        <SelectableRow current onSelect={vi.fn()}>
          On
        </SelectableRow>
        <SelectableRow current={false} onSelect={vi.fn()}>
          Off
        </SelectableRow>
      </>,
    );

    const on = screen.getByRole('button', { name: 'On' });
    const off = screen.getByRole('button', { name: 'Off' });
    expect(on).toHaveClass('border-l-[3px]', 'border-l-primary-600', 'bg-primary-100');
    expect(off).toHaveClass('border-l-[3px]', 'border-l-transparent');
    expect(off).not.toHaveClass('bg-primary-100');
  });

  it('frames the selected row instead when its left edge carries another meaning', () => {
    render(
      <SelectableRow current marker="frame" onSelect={vi.fn()} className="border-l-4">
        Maintenance window
      </SelectableRow>,
    );

    const row = screen.getByRole('button', { name: 'Maintenance window' });
    expect(row).toHaveClass('ring-1', 'ring-inset', 'ring-primary-600', 'border-l-4');
    expect(row).not.toHaveClass('border-l-[3px]');
  });

  it('shows keyboard focus with an outline, which the selection mark never draws', () => {
    render(
      <SelectableRow current={false} onSelect={vi.fn()}>
        Row
      </SelectableRow>,
    );

    expect(screen.getByRole('button', { name: 'Row' })).toHaveClass(
      'focus-visible:outline-2',
      'focus-visible:outline-primary-600',
    );
  });
});
