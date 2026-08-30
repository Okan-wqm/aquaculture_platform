/**
 * IconButton specs (MOB-MEDIUM-009) — the touch-floor primitive behaves:
 * it is an accessible button that always carries the 44px floor and merges
 * caller styling without dropping it.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { IconButton } from '../IconButton';

describe('IconButton', () => {
  it('renders an accessible button that meets the 44px touch floor', () => {
    render(
      <IconButton aria-label="Settings">
        <span>icon</span>
      </IconButton>,
    );

    const btn = screen.getByRole('button', { name: 'Settings' });
    expect(btn).toBeInTheDocument();
    expect(btn.className).toContain('min-h-touch');
    expect(btn.className).toContain('min-w-touch');
    // Defaults to a non-submit button so it never accidentally submits a form.
    expect(btn).toHaveAttribute('type', 'button');
  });

  it('merges caller classes without dropping the floor and forwards handlers', () => {
    const onClick = vi.fn();
    render(
      <IconButton aria-label="Play speed" className="bg-white/20" onClick={onClick}>
        1x
      </IconButton>,
    );

    const btn = screen.getByRole('button', { name: 'Play speed' });
    expect(btn.className).toContain('min-h-touch');
    expect(btn.className).toContain('bg-white/20');
    btn.click();
    expect(onClick).toHaveBeenCalledOnce();
  });
});
