/**
 * `required` reaches the control (FE-HIGH-087).
 *
 * Every field primitive painted a red asterisk for `required` and forwarded
 * nothing to the DOM, so "this field is mandatory" was a purely visual claim
 * on every form in the product. The native attribute (or aria-required on a
 * trigger button) is what assistive technology and the browser read.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Input, Textarea } from '../Input';
import { Select } from '../Select';
import { NumberInput } from '../NumberInput';
import { DatePicker } from '../DatePicker';

describe('required reaches the control', () => {
  it('Input, Textarea, Select and NumberInput set the native attribute and aria-required', () => {
    render(
      <>
        <Input label="Ad" required />
        <Textarea label="Not" required />
        <Select label="Tür" required options={[{ value: 'a', label: 'A' }]} />
        <NumberInput label="Miktar" required />
      </>,
    );
    for (const name of ['Ad', 'Not', 'Tür', 'Miktar']) {
      const control = screen.getByLabelText(new RegExp(`^${name}`));
      expect(control.hasAttribute('required')).toBe(true);
      expect(control.getAttribute('aria-required')).toBe('true');
    }
  });

  it('an optional field carries neither', () => {
    render(<Input label="Takma ad" />);
    const control = screen.getByLabelText(/^Takma ad/);
    expect(control.hasAttribute('required')).toBe(false);
    expect(control.getAttribute('aria-required')).toBeNull();
  });

  it('DatePicker marks its trigger aria-required', () => {
    render(<DatePicker label="Tarih" required value={null} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /Tarih|Seç|Select/i }).getAttribute('aria-required')).toBe('true');
  });
});
