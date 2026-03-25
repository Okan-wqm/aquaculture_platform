/**
 * Phase 4B expression editor UI tests -- verifies ExpressionEditor,
 * ExpressionBindingSection, and FunctionReference components.
 *
 * Covers:
 *   1.  ExpressionEditor renders textarea with placeholder
 *   2.  ExpressionEditor shows validation error for invalid expression
 *   3.  ExpressionEditor shows green check for valid expression
 *   4.  ExpressionEditor shows dependency tags as badges
 *   5.  ExpressionEditor live preview shows computed value
 *   6.  ExpressionBindingSection renders collapsed by default
 *   7.  ExpressionBindingSection enable toggle shows editor
 *   8.  ExpressionBindingSection quick examples are clickable
 *   9.  FunctionReference shows all function categories
 *  10.  FunctionReference shows function signatures
 */

import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/* ------------------------------------------------------------------ */
/*  Mocks                                                               */
/* ------------------------------------------------------------------ */

/**
 * useDeviceTags mock -- provides a stable set of tags for autocomplete
 * testing without network calls.
 */
vi.mock('../hooks/useDeviceTags', () => ({
  useDeviceTags: (_deviceId: string | null) => ({
    tags: [
      { name: 'temperature', ioType: 'AI', direction: 'input', unit: 'C', channel: 0 },
      { name: 'pressure', ioType: 'AI', direction: 'input', unit: 'bar', channel: 1 },
      { name: 'flow', ioType: 'AI', direction: 'input', unit: 'L/min', channel: 2 },
      { name: 'level', ioType: 'AI', direction: 'input', unit: '%', channel: 3 },
    ],
    groupedTags: [],
    loading: false,
    error: null,
  }),
}));

/* ------------------------------------------------------------------ */
/*  Imports (after mocks)                                               */
/* ------------------------------------------------------------------ */

import { ExpressionEditor } from '../components/scada-builder/widget-configs/ExpressionEditor';
import { ExpressionBindingSection } from '../components/scada-builder/widget-configs/ExpressionBindingSection';
import { FunctionReference } from '../components/scada-builder/widget-configs/FunctionReference';

/* ================================================================== */
/*  Tests                                                               */
/* ================================================================== */

describe('ExpressionEditor', () => {
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChange = vi.fn();
    vi.useFakeTimers();
  });

  /* -------------------------------------------------------------- */
  /*  1. Renders textarea with placeholder                           */
  /* -------------------------------------------------------------- */

  it('renders textarea with placeholder', () => {
    render(
      <ExpressionEditor
        expression=""
        onChange={onChange}
        placeholder="Enter expression..."
      />,
    );

    const textarea = screen.getByTestId('expression-textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.placeholder).toBe('Enter expression...');
    expect(textarea.tagName.toLowerCase()).toBe('textarea');
  });

  /* -------------------------------------------------------------- */
  /*  2. Shows validation error for invalid expression               */
  /* -------------------------------------------------------------- */

  it('shows validation error for invalid expression', async () => {
    render(
      <ExpressionEditor
        expression="${temperature} + ("
        onChange={onChange}
      />,
    );

    // Advance past debounce timer
    act(() => {
      vi.advanceTimersByTime(350);
    });

    const validation = screen.getByTestId('expression-validation');
    expect(validation).toBeTruthy();

    const invalidIcon = screen.getByTestId('validation-invalid');
    expect(invalidIcon).toBeTruthy();

    expect(validation.textContent).toContain('Unclosed parenthesis');
  });

  /* -------------------------------------------------------------- */
  /*  3. Shows green check for valid expression                      */
  /* -------------------------------------------------------------- */

  it('shows green check for valid expression', () => {
    render(
      <ExpressionEditor
        expression="${temperature} * 1.8 + 32"
        onChange={onChange}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(350);
    });

    const validIcon = screen.getByTestId('validation-valid');
    expect(validIcon).toBeTruthy();
  });

  /* -------------------------------------------------------------- */
  /*  4. Shows dependency tags as badges                             */
  /* -------------------------------------------------------------- */

  it('shows dependency tags as badges', () => {
    render(
      <ExpressionEditor
        expression="${temperature} + ${pressure}"
        onChange={onChange}
      />,
    );

    const deps = screen.getByTestId('expression-dependencies');
    expect(deps).toBeTruthy();
    expect(deps.textContent).toContain('temperature');
    expect(deps.textContent).toContain('pressure');
  });

  /* -------------------------------------------------------------- */
  /*  5. Live preview shows computed value                           */
  /* -------------------------------------------------------------- */

  it('live preview shows computed value when tagValues provided', () => {
    render(
      <ExpressionEditor
        expression="${temperature} * 1.8 + 32"
        onChange={onChange}
        tagValues={{ temperature: 25 }}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(350);
    });

    const preview = screen.getByTestId('expression-preview');
    expect(preview).toBeTruthy();
    // 25 * 1.8 + 32 = 77
    expect(preview.textContent).toContain('77');
  });
});

/* ================================================================== */
/*  ExpressionBindingSection                                           */
/* ================================================================== */

describe('ExpressionBindingSection', () => {
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChange = vi.fn();
    vi.useFakeTimers();
  });

  /* -------------------------------------------------------------- */
  /*  6. Renders collapsed by default                                */
  /* -------------------------------------------------------------- */

  it('renders collapsed by default', () => {
    render(
      <ExpressionBindingSection
        expression={undefined}
        onChange={onChange}
      />,
    );

    // Section toggle should be visible
    const toggle = screen.getByTestId('expression-section-toggle');
    expect(toggle).toBeTruthy();
    expect(toggle.textContent).toContain('Computed Expression');

    // Editor should NOT be visible (collapsed)
    const textarea = screen.queryByTestId('expression-textarea');
    expect(textarea).toBeNull();
  });

  /* -------------------------------------------------------------- */
  /*  7. Enable toggle shows editor                                  */
  /* -------------------------------------------------------------- */

  it('shows editor when expanded and enabled', () => {
    render(
      <ExpressionBindingSection
        expression={undefined}
        onChange={onChange}
      />,
    );

    // Expand the section
    const sectionToggle = screen.getByTestId('expression-section-toggle');
    fireEvent.click(sectionToggle);

    // Enable the expression binding
    const enableToggle = screen.getByTestId('expression-enable-toggle');
    expect(enableToggle).toBeTruthy();
    fireEvent.click(enableToggle);

    // onChange should be called with empty string (enabled)
    expect(onChange).toHaveBeenCalledWith('');
  });

  /* -------------------------------------------------------------- */
  /*  8. Quick examples are clickable                                */
  /* -------------------------------------------------------------- */

  it('quick examples are clickable and set expression', () => {
    render(
      <ExpressionBindingSection
        expression=""
        onChange={onChange}
      />,
    );

    // Expand the section
    const sectionToggle = screen.getByTestId('expression-section-toggle');
    fireEvent.click(sectionToggle);

    // Click a quick example
    const cfExample = screen.getByTestId('quick-example-c->f');
    expect(cfExample).toBeTruthy();
    fireEvent.click(cfExample);

    expect(onChange).toHaveBeenCalledWith('${temperature} * 1.8 + 32');
  });
});

/* ================================================================== */
/*  FunctionReference                                                   */
/* ================================================================== */

describe('FunctionReference', () => {
  /* -------------------------------------------------------------- */
  /*  9. Shows all function categories                               */
  /* -------------------------------------------------------------- */

  it('shows all function categories when opened', () => {
    render(<FunctionReference />);

    // Open the popover
    const trigger = screen.getByTestId('function-reference-trigger');
    fireEvent.click(trigger);

    const popover = screen.getByTestId('function-reference-popover');
    expect(popover).toBeTruthy();

    // Verify all 5 categories
    expect(screen.getByTestId('fn-group-math')).toBeTruthy();
    expect(screen.getByTestId('fn-group-range')).toBeTruthy();
    expect(screen.getByTestId('fn-group-interpolation')).toBeTruthy();
    expect(screen.getByTestId('fn-group-logic')).toBeTruthy();
    expect(screen.getByTestId('fn-group-conversion')).toBeTruthy();
  });

  /* -------------------------------------------------------------- */
  /*  10. Shows function signatures                                  */
  /* -------------------------------------------------------------- */

  it('shows function signatures with correct format', () => {
    render(<FunctionReference />);

    // Open the popover
    const trigger = screen.getByTestId('function-reference-trigger');
    fireEvent.click(trigger);

    // Check specific function signatures exist
    expect(screen.getByTestId('fn-sig-abs').textContent).toBe('abs(x)');
    expect(screen.getByTestId('fn-sig-clamp').textContent).toBe('clamp(val, min, max)');
    expect(screen.getByTestId('fn-sig-lerp').textContent).toBe('lerp(a, b, t)');
    expect(screen.getByTestId('fn-sig-if').textContent).toBe('if(cond, then, else)');
    expect(screen.getByTestId('fn-sig-deg2rad').textContent).toBe('deg2rad(d)');
    expect(screen.getByTestId('fn-sig-map').textContent).toBe('map(val, inMin, inMax, outMin, outMax)');
  });
});
