/**
 * Button — `surface="glass"` variant
 *
 * Pins that glass REPLACES the variant color (no competing bg-* utility) and that
 * the default surface is unchanged (no-breakage).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Button } from '../Button';

describe('Button surface="glass"', () => {
  it('uses glass button tokens and drops the variant color', () => {
    render(<Button surface="glass">Giriş</Button>);
    const btn = screen.getByRole('button', { name: 'Giriş' });
    expect(btn.className).toContain('bg-[var(--surface-btn-bg)]');
    expect(btn.className).toContain('hover:bg-[var(--surface-btn-bg-hover)]');
    expect(btn.className).toContain('text-[var(--surface-btn-fg)]');
    // glass replaces the primary variant → no raw blue bg
    expect(btn.className).not.toContain('bg-blue-600');
  });

  it('default surface keeps the primary variant (additive / no-breakage)', () => {
    render(<Button>Giriş</Button>);
    const btn = screen.getByRole('button', { name: 'Giriş' });
    expect(btn.className).toContain('bg-blue-600');
    expect(btn.className).not.toContain('--surface-btn');
  });
});
