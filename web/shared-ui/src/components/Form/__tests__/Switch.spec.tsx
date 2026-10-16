/**
 * Switch — one control, named and described by its visible text.
 *
 * The track is the `role="switch"` button; the checkbox under it exists only
 * for forms (`ref`, `name`, the label's click). Exposed, that checkbox made a
 * screen reader meet the setting twice and Tab stop on it twice. These specs
 * pin the single control, its name and description, keyboard-only focus ring,
 * and `labelPlacement="start"` — a settings row, label first and the track at
 * the far edge.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Switch } from '../Checkbox';

function Controlled({ labelPlacement }: { labelPlacement?: 'end' | 'start' }): React.ReactElement {
  const [on, setOn] = useState(false);
  return (
    <Switch
      label="Email"
      description="Alerts by email"
      labelPlacement={labelPlacement}
      checked={on}
      onChange={(event) => setOn(event.target.checked)}
    />
  );
}

describe('Switch', () => {
  it('is one switch named by its label and described by its description', () => {
    render(<Controlled />);

    const control = screen.getByRole('switch', { name: 'Email' });
    expect(control).toHaveAttribute('aria-checked', 'false');
    expect(control).toHaveAccessibleDescription('Alerts by email');
    // The form checkbox is not a second control.
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('takes one tab stop and toggles with Space, Enter and a click on its label', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Controlled />
        <button type="button">After</button>
      </>,
    );

    const control = screen.getByRole('switch', { name: 'Email' });
    await user.tab();
    expect(control).toHaveFocus();
    await user.keyboard(' ');
    expect(control).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{Enter}');
    expect(control).toHaveAttribute('aria-checked', 'false');
    await user.click(screen.getByText('Email'));
    expect(control).toHaveAttribute('aria-checked', 'true');

    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('draws its focus ring for keyboard focus only', () => {
    render(<Controlled />);

    const control = screen.getByRole('switch', { name: 'Email' });
    expect(control).toHaveClass('focus-visible:ring-2', 'focus-visible:ring-primary-500');
    expect(control.className).not.toMatch(/(?<![\w-])focus:ring-2/);
  });

  it('puts the label first and the track at the far edge with labelPlacement="start"', () => {
    const { container } = render(<Controlled labelPlacement="start" />);

    const row = container.firstElementChild;
    expect(row).toHaveClass('justify-between');
    const control = screen.getByRole('switch', { name: 'Email' });
    const label = screen.getByText('Email');
    expect(label.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the track first by default', () => {
    render(<Controlled />);

    const control = screen.getByRole('switch', { name: 'Email' });
    const label = screen.getByText('Email');
    expect(control.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('reports no change while disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Switch label="Email" checked={false} disabled onChange={onChange} />);

    await user.click(screen.getByRole('switch', { name: 'Email' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
