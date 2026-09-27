/**
 * Field primitives — label ↔ control, error wiring, required, touch floor
 * (FE-MEDIUM-091).
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { Button } from '../Button';
import { Input, Select, Textarea } from '../Field';
import { Switch } from '../Switch';

describe('Field primitives', () => {
  it('Input binds its label, forwards required, and wires the error to the control', () => {
    const { rerender } = render(
      <Input label="Lot / Batch Number" required value="" onChange={vi.fn()} />,
    );
    const control = screen.getByLabelText(/Lot \/ Batch Number/);
    expect(control.tagName).toBe('INPUT');
    expect(control.hasAttribute('required')).toBe(true);
    expect(control.getAttribute('aria-invalid')).toBeNull();
    expect(control.className).toContain('min-h-touch');

    rerender(
      <Input
        label="Lot / Batch Number"
        required
        value=""
        onChange={vi.fn()}
        error="Lot number is required"
      />,
    );
    const invalid = screen.getByLabelText(/Lot \/ Batch Number/);
    expect(invalid.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').id).toBe(invalid.getAttribute('aria-describedby'));
  });

  it('a hidden label still names the control', () => {
    render(
      <Select label="Tank" hideLabel value="" onChange={vi.fn()}>
        <option value="">-- Select Tank --</option>
      </Select>,
    );
    const select = screen.getByLabelText('Tank');
    expect(select.tagName).toBe('SELECT');
    render(<Textarea label="Notes" hideLabel value="" onChange={vi.fn()} />);
    expect(screen.getByLabelText('Notes').tagName).toBe('TEXTAREA');
  });

  it('Switch is a named switch on the touch floor and reports the next state', () => {
    const onChange = vi.fn();
    render(<Switch label="Half Day" checked={false} onChange={onChange} />);
    const control = screen.getByRole('switch', { name: 'Half Day' });
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(control.className).toContain('min-h-touch');
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('Button carries the touch floor and a busy state that disables it', () => {
    const { rerender } = render(<Button>Sync Now</Button>);
    const button = screen.getByRole('button', { name: 'Sync Now' });
    expect(button.className).toContain('min-h-touch');
    expect(button.getAttribute('type')).toBe('button');
    rerender(<Button loading>Sync Now</Button>);
    expect(screen.getByRole('button', { name: /Sync Now/ }).hasAttribute('disabled')).toBe(true);
  });
});
