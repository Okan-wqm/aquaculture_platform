/**
 * ToggleButton — paint and announcement come from one prop (FE-HIGH-159).
 */
import { render, screen, fireEvent } from '@testing-library/react';
import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';

import { ToggleButton } from '../ToggleButton';

describe('ToggleButton (AquaMobil)', () => {
  it('announces the state it paints', () => {
    render(
      <ToggleButton pressed className="row" pressedClassName="on" idleClassName="off">
        Cold store
      </ToggleButton>,
    );
    const button = screen.getByRole('button', { name: 'Cold store', pressed: true });
    expect(button.className).toBe('row on');
  });

  it('keeps the two in step across a toggle, and defaults to type=button', () => {
    const Host: React.FC = () => {
      const [on, setOn] = useState(false);
      return (
        <ToggleButton
          pressed={on}
          onPressedChange={setOn}
          pressedClassName="on"
          idleClassName="off"
        >
          Dry store
        </ToggleButton>
      );
    };
    render(<Host />);
    const button = screen.getByRole('button', { name: 'Dry store' });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.className).toBe('off');
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.className).toBe('on');
  });

  it('still calls onClick', () => {
    const onClick = vi.fn();
    render(
      <ToggleButton pressed={false} onClick={onClick}>
        Pick
      </ToggleButton>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pick' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
