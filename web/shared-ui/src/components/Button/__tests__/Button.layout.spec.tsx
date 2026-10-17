/**
 * Button — `layout="row"`.
 *
 * A list row or section-nav entry is a whole-row button whose box belongs to
 * the row: full width, content from the start edge, no radius, padding or
 * fill. It replaces the inline box rather than adding to it — `block` beside
 * `inline-flex`, or the caller's padding beside a size's, would be settled by
 * stylesheet order, not by the caller. These specs pin that the row keeps what
 * Button owns (type, focus treatment, ref) and drops what the row paints.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Button } from '../Button';

describe('Button layout="row"', () => {
  it('is a full-width row from the start edge with none of the inline box', () => {
    render(
      <Button layout="row" className="px-4 py-3">
        General
      </Button>,
    );

    const row = screen.getByRole('button', { name: 'General' });
    expect(row).toHaveClass('block', 'w-full', 'text-left', 'px-4', 'py-3');
    for (const inline of [
      'inline-flex',
      'justify-center',
      'rounded-lg',
      'font-medium',
      'focus:ring-2',
      'bg-primary-600',
      'py-2',
      'min-h-[40px]',
    ]) {
      expect(row.className.split(' ')).not.toContain(inline);
    }
  });

  it('marks keyboard focus with an inset accent outline, never a ring', () => {
    render(<Button layout="row">Row</Button>);

    const row = screen.getByRole('button', { name: 'Row' });
    expect(row).toHaveClass(
      'focus-visible:outline-2',
      'focus-visible:-outline-offset-2',
      'focus-visible:outline-primary-600',
    );
    expect(row.className).not.toMatch(/\bring-/);
  });

  it('keeps what Button owns: type="button", ARIA pass-through, the ref and activation', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(
      <Button layout="row" ref={ref} aria-current="page" onClick={onClick}>
        Billing
      </Button>,
    );

    const row = screen.getByRole('button', { name: 'Billing' });
    expect(row).toHaveAttribute('type', 'button');
    expect(row).toHaveAttribute('aria-current', 'page');
    expect(row).not.toHaveAttribute('layout');
    expect(ref.current).toBe(row);
    await user.tab();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('leaves the default inline box unchanged (no-breakage)', () => {
    render(<Button>Save</Button>);

    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveClass(
      'inline-flex',
      'justify-center',
      'rounded-lg',
      'bg-primary-600',
      'focus:ring-2',
    );
    expect(button).not.toHaveClass('block', 'text-left');
  });
});
