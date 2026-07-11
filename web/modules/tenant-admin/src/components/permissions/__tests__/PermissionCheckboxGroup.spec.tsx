/**
 * PermissionCheckboxGroup Tests
 *
 * RBAC-MEDIUM-007 (plan RBAC-M16): the category select-all used to be a
 * click-only <span role="checkbox"> NESTED inside the expand <button> —
 * invalid interactive-inside-interactive (WCAG 4.1.2) and unreachable by
 * keyboard (WCAG 2.1.1). These tests pin the fixed contract: the select-all
 * is a real sibling button with checkbox semantics, keyboard-togglable, and
 * independent of the expand/collapse trigger.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import { PermissionCheckboxGroup } from '../PermissionCheckboxGroup';

const categories = [
  {
    categoryKey: 'farm',
    name: 'Farm',
    resources: [
      { name: 'ponds', actions: ['view', 'edit'] },
      { name: 'batches', actions: ['view'] },
    ],
  },
];

const onChange = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PermissionCheckboxGroup category select-all (RBAC-MEDIUM-007)', () => {
  it('exposes the category select-all as a real checkbox-semantics BUTTON, not a span inside the expand button', () => {
    render(<PermissionCheckboxGroup categories={categories} value={{}} onChange={onChange} />);

    const selectAll = screen.getByRole('checkbox', { name: 'Select all permissions in Farm' });
    expect(selectAll.tagName).toBe('BUTTON');
    expect(selectAll).toHaveAttribute('aria-checked', 'false');
    // Structural invariant: no interactive-inside-interactive nesting.
    expect(selectAll.closest('button')).toBe(selectAll);
  });

  it('is keyboard-reachable and toggles the whole category with Space', async () => {
    const user = userEvent.setup();
    render(<PermissionCheckboxGroup categories={categories} value={{}} onChange={onChange} />);

    const selectAll = screen.getByRole('checkbox', { name: 'Select all permissions in Farm' });
    selectAll.focus();
    expect(selectAll).toHaveFocus();

    await user.keyboard(' ');

    expect(onChange).toHaveBeenCalledWith({
      farm: { ponds: { view: true, edit: true }, batches: { view: true } },
    });
  });

  it('toggling select-all does NOT collapse/expand the accordion', async () => {
    const user = userEvent.setup();
    render(<PermissionCheckboxGroup categories={categories} value={{}} onChange={onChange} />);

    const expandButton = screen.getByRole('button', { name: /Farm \(0\/3\)/ });
    expect(expandButton).toHaveAttribute('aria-expanded', 'true');

    await user.click(screen.getByRole('checkbox', { name: 'Select all permissions in Farm' }));

    expect(expandButton).toHaveAttribute('aria-expanded', 'true');
  });

  it('reports mixed state when only some permissions are selected', () => {
    render(
      <PermissionCheckboxGroup
        categories={categories}
        value={{ farm: { ponds: { view: true } } }}
        onChange={onChange}
      />,
    );

    expect(
      screen.getByRole('checkbox', { name: 'Select all permissions in Farm' }),
    ).toHaveAttribute('aria-checked', 'mixed');
  });

  it('resource select-all carries checkbox semantics too', () => {
    render(<PermissionCheckboxGroup categories={categories} value={{}} onChange={onChange} />);

    const resourceSelectAll = screen.getByRole('checkbox', { name: 'Select all Ponds permissions' });
    expect(resourceSelectAll.tagName).toBe('BUTTON');
    expect(resourceSelectAll).toHaveAttribute('aria-checked', 'false');
  });

  it('select-all is disabled in readOnly mode', () => {
    render(
      <PermissionCheckboxGroup categories={categories} value={{}} onChange={onChange} readOnly />,
    );

    expect(
      screen.getByRole('checkbox', { name: 'Select all permissions in Farm' }),
    ).toBeDisabled();
  });
});
