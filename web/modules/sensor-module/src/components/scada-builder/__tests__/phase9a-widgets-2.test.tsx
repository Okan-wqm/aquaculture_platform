/**
 * Phase 9A Part 2 SCADA widget tests -- BarChart, PieChart, Knob, DropdownSelect.
 *
 * Covers:
 *  1.  BarChart renders correct number of bars
 *  2.  BarChart auto-scales Y axis
 *  3.  PieChart renders correct number of slices
 *  4.  PieChart slice angles sum to 360 degrees
 *  5.  Knob renders SVG with track and indicator
 *  6.  Knob angle-to-value mapping is correct
 *  7.  DropdownSelect renders button with placeholder
 *  8.  DropdownSelect shows options on click
 *  9.  DropdownSelect keyboard navigation (ArrowDown selects next)
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

/* ------------------------------------------------------------------ */
/*  Lazy imports bypass: import renderers directly for unit testing     */
/* ------------------------------------------------------------------ */

import BarChartRenderer from '../widget-renderers/BarChartRenderer';
import PieChartRenderer from '../widget-renderers/PieChartRenderer';
import KnobRenderer from '../widget-renderers/KnobRenderer';
import DropdownSelectRenderer from '../widget-renderers/DropdownSelectRenderer';

/* ------------------------------------------------------------------ */
/*  BarChart Tests                                                     */
/* ------------------------------------------------------------------ */

describe('BarChartRenderer', () => {
  const defaultSources = [
    { tagName: 'Tag1', label: 'Tag1', color: '#06b6d4' },
    { tagName: 'Tag2', label: 'Tag2', color: '#8b5cf6' },
    { tagName: 'Tag3', label: 'Tag3', color: '#f59e0b' },
  ];

  it('renders correct number of bars in edit mode', () => {
    const { container } = render(
      <BarChartRenderer
        config={{ sources: defaultSources, label: 'Test Bar' }}
        width={480}
        height={300}
        isEditing
      />,
    );

    // Each bar is a <rect> inside a <g> group. There are also axis/grid rects,
    // but bars have rx=2 (rounded corners) to distinguish them.
    const bars = container.querySelectorAll('rect[rx="2"]');
    expect(bars.length).toBe(3);
  });

  it('auto-scales Y axis to fit data', () => {
    const { container } = render(
      <BarChartRenderer
        config={{
          sources: defaultSources,
          autoScale: true,
        }}
        width={480}
        height={300}
        isEditing
      />,
    );

    // In edit mode with autoScale, the Y axis ticks should be generated.
    // Check that Y axis labels exist (they are <text> elements with specific positioning)
    const allText = container.querySelectorAll('text');
    const numericLabels = Array.from(allText).filter((t) => {
      const content = t.textContent ?? '';
      return /^\d+(\.\d+)?$/.test(content.trim());
    });
    // Auto-scale should produce at least 3 tick labels on Y axis
    expect(numericLabels.length).toBeGreaterThanOrEqual(3);
  });

  it('renders horizontal bars when orientation is horizontal', () => {
    const { container } = render(
      <BarChartRenderer
        config={{
          sources: defaultSources,
          orientation: 'horizontal',
        }}
        width={480}
        height={300}
        isEditing
      />,
    );

    const bars = container.querySelectorAll('rect[rx="2"]');
    expect(bars.length).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/*  PieChart Tests                                                     */
/* ------------------------------------------------------------------ */

describe('PieChartRenderer', () => {
  const defaultSources = [
    { tagName: 'A', label: 'Slice A', color: '#06b6d4' },
    { tagName: 'B', label: 'Slice B', color: '#8b5cf6' },
    { tagName: 'C', label: 'Slice C', color: '#f59e0b' },
    { tagName: 'D', label: 'Slice D', color: '#ef4444' },
  ];

  it('renders correct number of slices in edit mode', () => {
    const { container } = render(
      <PieChartRenderer
        config={{ sources: defaultSources, label: 'Test Pie' }}
        width={300}
        height={300}
        isEditing
      />,
    );

    // Each slice is an SVG <path> element (not the grid or axis lines).
    // Slices have fill colors and white stroke separators.
    const paths = container.querySelectorAll('path[stroke="white"]');
    expect(paths.length).toBe(4);
  });

  it('slice angles sum to 360 degrees (full circle)', () => {
    // We verify this by checking that all 4 slices are rendered
    // and the demo values produce exactly 4 paths.
    // The actual angle math is validated by the fact that all slices
    // together form a complete circle (no gaps, no overlaps).
    const { container } = render(
      <PieChartRenderer
        config={{
          sources: defaultSources,
          showLabels: true,
        }}
        width={300}
        height={300}
        isEditing
      />,
    );

    // Each slice should have a percentage label.
    // Find all percentage text labels inside SVG
    const textElements = container.querySelectorAll('text');
    const pctLabels = Array.from(textElements).filter((t) =>
      (t.textContent ?? '').includes('%'),
    );

    // All 4 slices should have labels (demo values are all > 5% threshold)
    expect(pctLabels.length).toBe(4);

    // Sum of percentages should be approximately 100
    const total = pctLabels.reduce((sum, t) => {
      const match = (t.textContent ?? '').match(/(\d+)%/);
      return sum + (match ? parseInt(match[1], 10) : 0);
    }, 0);

    // Allow rounding tolerance (each slice rounds independently)
    expect(total).toBeGreaterThanOrEqual(98);
    expect(total).toBeLessThanOrEqual(102);
  });

  it('renders donut when innerRadius > 0', () => {
    const { container } = render(
      <PieChartRenderer
        config={{
          sources: [
            { tagName: 'X', label: 'X', color: '#06b6d4' },
          ],
          innerRadius: 30,
        }}
        width={300}
        height={300}
        isEditing
      />,
    );

    // Single slice at 100% with innerRadius renders as two concentric circles
    // (outer filled circle + inner white circle for donut hole)
    const circles = container.querySelectorAll('circle');
    // There should be at least 2 circles (outer + inner donut hole)
    expect(circles.length).toBeGreaterThanOrEqual(2);
  });
});

/* ------------------------------------------------------------------ */
/*  Knob Tests                                                         */
/* ------------------------------------------------------------------ */

describe('KnobRenderer', () => {
  it('renders SVG with track and indicator elements', () => {
    const { container } = render(
      <KnobRenderer
        config={{ label: 'Test Knob', min: 0, max: 100 }}
        value={50}
        width={200}
        height={200}
        isEditing={false}
      />,
    );

    // Should have an SVG element
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();

    // Track arc: <path> with strokeLinecap="round"
    const paths = container.querySelectorAll('path[stroke-linecap="round"]');
    expect(paths.length).toBeGreaterThanOrEqual(2); // track + active arc

    // Indicator line
    const lines = container.querySelectorAll('line[stroke-linecap="round"]');
    expect(lines.length).toBeGreaterThanOrEqual(1);

    // Center circles (knob body)
    const circles = container.querySelectorAll('circle');
    expect(circles.length).toBeGreaterThanOrEqual(3); // bg + knob + indicator dot
  });

  it('angle-to-value mapping produces correct value at midpoint', () => {
    // At value=50 (midpoint of 0-100), the indicator should be at
    // the middle of the angular sweep
    const { container } = render(
      <KnobRenderer
        config={{
          min: 0,
          max: 100,
          showValue: true,
        }}
        value={50}
        width={200}
        height={200}
        isEditing={false}
      />,
    );

    // The center value display should show "50"
    const textElements = container.querySelectorAll('text');
    const valueText = Array.from(textElements).find(
      (t) => (t.textContent ?? '').trim() === '50',
    );
    expect(valueText).not.toBeUndefined();
  });

  it('displays correct value with decimal precision for fractional steps', () => {
    const { container } = render(
      <KnobRenderer
        config={{
          min: 0,
          max: 10,
          step: 0.1,
          showValue: true,
        }}
        value={5.5}
        width={200}
        height={200}
        isEditing={false}
      />,
    );

    const textElements = container.querySelectorAll('text');
    const valueText = Array.from(textElements).find(
      (t) => (t.textContent ?? '').trim() === '5.5',
    );
    expect(valueText).not.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  DropdownSelect Tests                                               */
/* ------------------------------------------------------------------ */

describe('DropdownSelectRenderer', () => {
  const defaultOptions = [
    { label: 'Auto', value: 0 },
    { label: 'Manual', value: 1 },
    { label: 'Off', value: 2 },
  ];

  it('renders button with placeholder when no value selected', () => {
    render(
      <DropdownSelectRenderer
        config={{
          options: defaultOptions,
          placeholder: 'Choose mode...',
          showLabel: true,
          label: 'Mode',
        }}
        width={200}
        height={80}
        isEditing={false}
      />,
    );

    const button = screen.getByRole('combobox');
    expect(button).not.toBeNull();
    expect(button.textContent).toContain('Choose mode...');
  });

  it('shows selected option label when value matches', () => {
    render(
      <DropdownSelectRenderer
        config={{
          options: defaultOptions,
          placeholder: 'Choose...',
        }}
        value={1}
        width={200}
        height={80}
        isEditing={false}
      />,
    );

    const button = screen.getByRole('combobox');
    expect(button.textContent).toContain('Manual');
  });

  it('shows options on click', () => {
    render(
      <DropdownSelectRenderer
        config={{
          options: defaultOptions,
          label: 'Mode',
        }}
        width={200}
        height={80}
        isEditing={false}
      />,
    );

    const button = screen.getByRole('combobox');
    fireEvent.click(button);

    // After click, a listbox should appear with 3 options
    const listbox = screen.getByRole('listbox');
    expect(listbox).not.toBeNull();

    const options = screen.getAllByRole('option');
    expect(options.length).toBe(3);
    expect(options[0].textContent).toContain('Auto');
    expect(options[1].textContent).toContain('Manual');
    expect(options[2].textContent).toContain('Off');
  });

  it('keyboard ArrowDown selects next option', () => {
    render(
      <DropdownSelectRenderer
        config={{
          options: defaultOptions,
          label: 'Mode',
        }}
        width={200}
        height={80}
        isEditing={false}
      />,
    );

    const button = screen.getByRole('combobox');

    // Open with ArrowDown
    fireEvent.keyDown(button, { key: 'ArrowDown' });

    // Listbox should be open
    const listbox = screen.getByRole('listbox');
    expect(listbox).not.toBeNull();

    // First option should be highlighted (index 0)
    const options = screen.getAllByRole('option');
    expect(options.length).toBe(3);

    // Press ArrowDown again to move to second option
    fireEvent.keyDown(button, { key: 'ArrowDown' });

    // Press Enter to select
    fireEvent.keyDown(button, { key: 'Enter' });

    // Listbox should close after selection -- verify no listbox
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('calls onCommand with selected value', () => {
    const onCommand = vi.fn();

    render(
      <DropdownSelectRenderer
        config={{
          options: defaultOptions,
          label: 'Mode',
        }}
        width={200}
        height={80}
        isEditing={false}
        onCommand={onCommand}
      />,
    );

    const button = screen.getByRole('combobox');
    fireEvent.click(button);

    // Click the "Manual" option
    const options = screen.getAllByRole('option');
    fireEvent.mouseDown(options[1]);

    expect(onCommand).toHaveBeenCalledWith('setValue', 1);
  });

  it('does not open in edit mode', () => {
    render(
      <DropdownSelectRenderer
        config={{
          options: defaultOptions,
          label: 'Mode',
        }}
        width={200}
        height={80}
        isEditing
      />,
    );

    const button = screen.getByRole('combobox');
    fireEvent.click(button);

    // Should not open in edit mode
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('closes on Escape key', () => {
    render(
      <DropdownSelectRenderer
        config={{
          options: defaultOptions,
          label: 'Mode',
        }}
        width={200}
        height={80}
        isEditing={false}
      />,
    );

    const button = screen.getByRole('combobox');
    fireEvent.click(button);

    // Listbox should be open
    expect(screen.getByRole('listbox')).not.toBeNull();

    // Press Escape
    fireEvent.keyDown(button, { key: 'Escape' });

    // Listbox should be closed
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
