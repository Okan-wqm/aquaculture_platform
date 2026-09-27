/**
 * FormField (FE-HIGH-086) — a caller's className overrides the default
 * bottom margin, so a field error can be shown inside an existing form row
 * without changing its rhythm; the error stays an alert tied to the control.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FormField } from '../FormField';

describe('FormField className merge', () => {
  it('lets mb-0 replace the default mb-4 and still announces the error', () => {
    const { container } = render(
      <FormField error="Please enter a name." className="mb-0">
        <input aria-label="Name" />
      </FormField>,
    );
    const wrapper = container.firstElementChild;
    expect(wrapper?.className).toContain('mb-0');
    expect(wrapper?.className).not.toContain('mb-4');
    expect(screen.getByRole('alert').textContent).toContain('Please enter a name.');
    expect(screen.getByLabelText('Name').getAttribute('aria-invalid')).toBe('true');
  });
});
