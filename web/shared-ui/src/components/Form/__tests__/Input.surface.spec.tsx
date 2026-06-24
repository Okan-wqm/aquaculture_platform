/**
 * Input — `surface="glass"` variant
 *
 * Pins the additive glass surface:
 *   1. glass applies the `var(--surface-*)` field + label tokens
 *   2. default (no surface) is unchanged → no glass tokens (no-breakage)
 *   3. the error state still wins over glass (red border present)
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Input } from '../Input';

describe('Input surface="glass"', () => {
  it('applies glass field + label tokens', () => {
    render(<Input surface="glass" label="E-posta" placeholder="x" />);
    const input = screen.getByLabelText('E-posta');
    expect(input.className).toContain('bg-[var(--surface-field-bg)]');
    expect(input.className).toContain('text-[var(--surface-field-fg)]');
    expect(input.className).toContain('border-[var(--surface-field-border)]');
    expect(input.className).toContain('placeholder:text-[var(--surface-field-placeholder)]');

    const label = screen.getByText('E-posta');
    expect(label.className).toContain('text-[var(--surface-label-fg)]');
  });

  it('default surface carries NO glass tokens (additive / no-breakage)', () => {
    render(<Input label="E-posta" />);
    const input = screen.getByLabelText('E-posta');
    expect(input.className).not.toContain('--surface-field');
    expect(input.className).toContain('border-gray-300');
    expect(input.className).toContain('bg-white');

    const label = screen.getByText('E-posta');
    expect(label.className).toContain('text-gray-700');
  });

  it('error state wins over glass (red border still applied)', () => {
    render(<Input surface="glass" label="E-posta" error="Hatalı" />);
    const input = screen.getByLabelText('E-posta');
    expect(input.className).toContain('border-red-500');
    // glass bg is still present, but the (error) border overrides the glass border
    expect(input.className).not.toContain('border-[var(--surface-field-border)]');
  });
});
