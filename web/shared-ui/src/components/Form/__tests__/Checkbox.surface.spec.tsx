/**
 * Checkbox — `surface="glass"` variant
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Checkbox } from '../Checkbox';

describe('Checkbox surface="glass"', () => {
  it('applies glass tokens to the box and label', () => {
    render(<Checkbox surface="glass" label="Beni hatırla" />);
    const box = screen.getByRole('checkbox');
    expect(box.className).toContain('text-[var(--surface-btn-bg)]');
    expect(box.className).toContain('border-[var(--surface-field-border)]');
    expect(box.className).toContain('focus:ring-[var(--surface-field-focus-ring)]');

    const label = screen.getByText('Beni hatırla');
    expect(label.className).toContain('text-[var(--surface-label-fg)]');
  });

  it('default surface unchanged (no-breakage)', () => {
    render(<Checkbox label="Beni hatırla" />);
    const box = screen.getByRole('checkbox');
    expect(box.className).toContain('text-blue-600');
    expect(box.className).toContain('border-gray-300');
    expect(box.className).not.toContain('--surface');
  });
});
