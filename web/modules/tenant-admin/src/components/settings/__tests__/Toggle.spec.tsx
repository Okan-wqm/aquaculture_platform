/**
 * Toggle / SmallToggle — the settings switches.
 *
 * SmallToggle (every cell of the Mobile Users table) rendered a bare button:
 * no switch role, no checked state, no name, and `focus:outline-hidden` with
 * no ring, so keyboard focus was invisible (WCAG 2.4.7, 4.1.2). It now takes
 * the switch semantics Toggle has, a required name (the type makes an unnamed
 * switch a compile error), and a visible focus ring.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { SmallToggle, Toggle } from '../Toggle';

function ControlledSmall({ label }: { label: string }): React.ReactElement {
  const [enabled, setEnabled] = useState(false);
  return <SmallToggle enabled={enabled} onChange={setEnabled} label={label} />;
}

describe('SmallToggle', () => {
  it('is a named switch that reports its state', () => {
    render(<SmallToggle enabled onChange={() => undefined} label="Ada Lovelace: Harvest" />);

    const toggle = screen.getByRole('switch', { name: 'Ada Lovelace: Harvest' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveAttribute('type', 'button');
  });

  it('flips with the keyboard and keeps focus on the switch', async () => {
    const user = userEvent.setup();
    render(<ControlledSmall label="Ada Lovelace: Mobile" />);

    const toggle = screen.getByRole('switch', { name: 'Ada Lovelace: Mobile' });
    await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveFocus();
  });

  it('draws a focus ring for keyboard focus', () => {
    render(<SmallToggle enabled={false} onChange={() => undefined} label="Ada: Cull" />);

    expect(screen.getByRole('switch', { name: 'Ada: Cull' })).toHaveClass(
      'focus-visible:ring-2',
      'focus-visible:ring-primary-500',
    );
  });
});

describe('Toggle', () => {
  it('is a switch named by its row label', () => {
    render(<Toggle enabled={false} onChange={() => undefined} label="Email alerts" />);

    expect(screen.getByRole('switch', { name: 'Email alerts' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });
});
