import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { Tooltip } from '../Tooltip';

describe('Tooltip', () => {
  it('shows on focus at once and describes the control; hides on blur and on Escape', () => {
    render(
      <Tooltip content="Align left">
        <button type="button" aria-label="Align left">
          ⇤
        </button>
      </Tooltip>,
    );
    const control = screen.getByRole('button', { name: 'Align left' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(control);
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe('Align left');
    expect(control.getAttribute('aria-describedby')).toBe(tip.id);
    fireEvent.keyDown(control, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(control);
    fireEvent.blur(control);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
