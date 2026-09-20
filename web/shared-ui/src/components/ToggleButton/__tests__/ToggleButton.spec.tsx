/**
 * ToggleButton — the prop that paints the selection is the prop that declares
 * it, so the two can never drift apart (FE-HIGH-159).
 */
import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ToggleButton } from '../ToggleButton';

describe('ToggleButton', () => {
  it('announces the pressed state it paints', () => {
    render(
      <ToggleButton pressed idleClassName="idle" pressedClassName="on" className="base">
        Grid
      </ToggleButton>,
    );
    const button = screen.getByRole('button', { name: 'Grid', pressed: true });
    expect(button.className).toBe('base on');
  });

  it('announces the idle state it paints', () => {
    render(
      <ToggleButton pressed={false} idleClassName="idle" pressedClassName="on" className="base">
        Grid
      </ToggleButton>,
    );
    const button = screen.getByRole('button', { name: 'Grid', pressed: false });
    expect(button.className).toBe('base idle');
  });

  it('is a plain button, not a submit, inside a form', () => {
    render(
      <form>
        <ToggleButton pressed={false}>Filter</ToggleButton>
      </form>,
    );
    expect(screen.getByRole('button', { name: 'Filter' })).toHaveAttribute('type', 'button');
  });

  it('hands onPressedChange the next state, and still calls onClick', () => {
    const onClick = vi.fn();
    const onPressedChange = vi.fn();
    render(
      <ToggleButton pressed onClick={onClick} onPressedChange={onPressedChange}>
        Alerts
      </ToggleButton>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Alerts' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onPressedChange).toHaveBeenCalledWith(false);
  });

  it('keeps paint and announcement in step across a real toggle', () => {
    const Host: React.FC = () => {
      const [on, setOn] = useState(false);
      return (
        <ToggleButton
          pressed={on}
          onPressedChange={setOn}
          className="chip"
          pressedClassName="chip-on"
          idleClassName="chip-off"
        >
          Email
        </ToggleButton>
      );
    };
    render(<Host />);
    const button = screen.getByRole('button', { name: 'Email' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(button.className).toBe('chip chip-off');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button.className).toBe('chip chip-on');
  });

  it('passes disabled and the accessible name through', () => {
    render(<ToggleButton pressed={false} disabled aria-label="Mute" />);
    const button = screen.getByRole('button', { name: 'Mute' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });
});
