/**
 * Phase 1.5A integration tests -- TagBrowser integration into Events/Animations
 * panels and universal RangeColorMapping component.
 *
 * Covers:
 *   1.  EventsPanel renders TagBrowser for targetTag (not plain input)
 *   2.  EventsPanel renders TagBrowser for toggleTag
 *   3.  AnimationsPanel renders TagBrowser for animation tagName
 *   4.  RangeColorMapping renders correct number of range rows
 *   5.  RangeColorMapping add button creates new range
 *   6.  RangeColorMapping remove button deletes range
 *   7.  RangeColorMapping validates min < max
 *   8.  RangeColorMapping sorts by min value
 *   9.  ColorRange interface has required fields
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* ------------------------------------------------------------------ */
/*  Mocks: TagBrowser relies on useDeviceTags which hits the API.     */
/*  We mock the entire TagBrowser to isolate panel-level integration. */
/* ------------------------------------------------------------------ */

vi.mock('../components/scada-builder/TagBrowser', () => ({
  TagBrowser: ({
    deviceId,
    value,
    onChange,
    placeholder,
  }: {
    deviceId: string | null;
    value: string;
    onChange: (tag: string) => void;
    placeholder?: string;
  }) => (
    <div data-testid="tag-browser" data-device-id={deviceId} data-value={value}>
      <input
        data-testid="tag-browser-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  ),
}));

// Mock the Zustand store used by EventsPanel
vi.mock('../store/scada', () => ({
  useScadaPackageStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ screens: [] }),
}));

/* ------------------------------------------------------------------ */
/*  Imports (after mocks)                                              */
/* ------------------------------------------------------------------ */

import { EventsPanel } from '../components/scada-builder/widget-configs/EventsPanel';
import { AnimationsPanel } from '../components/scada-builder/widget-configs/AnimationsPanel';
import { RangeColorMapping } from '../components/scada-builder/widget-configs/RangeColorMapping';
import type { ColorRange } from '../engine/animation/types';
import type { WidgetEventDef } from '../engine/events/types';
import type { AnimationRule } from '../engine/animation/types';

/* ================================================================== */
/*  EventsPanel: TagBrowser integration                                */
/* ================================================================== */

describe('EventsPanel TagBrowser integration', () => {
  const DEVICE_ID = 'edge-device-001';

  it('renders TagBrowser for targetTag in setValue action', () => {
    const events: WidgetEventDef[] = [
      {
        id: 'evt-1',
        trigger: 'click',
        action: 'setValue',
        params: { targetTag: 'sensor.temperature' },
      },
    ];
    const onChange = vi.fn();

    const { container } = render(
      <EventsPanel events={events} onChange={onChange} deviceId={DEVICE_ID} />,
    );

    // Should render TagBrowser instead of plain text input for targetTag
    const tagBrowsers = container.querySelectorAll('[data-testid="tag-browser"]');
    expect(tagBrowsers.length).toBeGreaterThanOrEqual(1);

    // Verify deviceId is passed through
    const firstBrowser = tagBrowsers[0];
    expect(firstBrowser.getAttribute('data-device-id')).toBe(DEVICE_ID);
    expect(firstBrowser.getAttribute('data-value')).toBe('sensor.temperature');
  });

  it('renders TagBrowser for toggleTag in toggleValue action', () => {
    const events: WidgetEventDef[] = [
      {
        id: 'evt-2',
        trigger: 'click',
        action: 'toggleValue',
        params: { toggleTag: 'pump.running' },
      },
    ];
    const onChange = vi.fn();

    const { container } = render(
      <EventsPanel events={events} onChange={onChange} deviceId={DEVICE_ID} />,
    );

    const tagBrowsers = container.querySelectorAll('[data-testid="tag-browser"]');
    expect(tagBrowsers.length).toBeGreaterThanOrEqual(1);

    const toggleBrowser = tagBrowsers[0];
    expect(toggleBrowser.getAttribute('data-device-id')).toBe(DEVICE_ID);
    expect(toggleBrowser.getAttribute('data-value')).toBe('pump.running');
  });
});

/* ================================================================== */
/*  AnimationsPanel: TagBrowser integration                            */
/* ================================================================== */

describe('AnimationsPanel TagBrowser integration', () => {
  const DEVICE_ID = 'edge-device-002';

  it('renders TagBrowser for animation tagName', () => {
    const animations: AnimationRule[] = [
      {
        id: 'anim-1',
        tagName: 'sensor.level',
        range: { min: 0, max: 100 },
        type: 'colorRange',
        options: {},
      },
    ];
    const onChange = vi.fn();

    const { container } = render(
      <AnimationsPanel animations={animations} onChange={onChange} deviceId={DEVICE_ID} />,
    );

    const tagBrowsers = container.querySelectorAll('[data-testid="tag-browser"]');
    expect(tagBrowsers.length).toBeGreaterThanOrEqual(1);

    const animBrowser = tagBrowsers[0];
    expect(animBrowser.getAttribute('data-device-id')).toBe(DEVICE_ID);
    expect(animBrowser.getAttribute('data-value')).toBe('sensor.level');
  });
});

/* ================================================================== */
/*  RangeColorMapping                                                  */
/* ================================================================== */

describe('RangeColorMapping', () => {
  let onChange: ReturnType<typeof vi.fn>;

  const defaultRanges: ColorRange[] = [
    { min: 0, max: 30, fill: '#22c55e' },
    { min: 30, max: 70, fill: '#eab308' },
    { min: 70, max: 100, fill: '#ef4444' },
  ];

  beforeEach(() => {
    onChange = vi.fn();
  });

  it('renders the correct number of range rows', () => {
    const { container } = render(
      <RangeColorMapping ranges={defaultRanges} onChange={onChange} />,
    );

    const rows = container.querySelectorAll('[data-testid="range-row"]');
    expect(rows.length).toBe(3);
  });

  it('add button creates a new range', () => {
    render(
      <RangeColorMapping ranges={defaultRanges} onChange={onChange} />,
    );

    const addBtn = screen.getByTestId('add-range-btn');
    fireEvent.click(addBtn);

    expect(onChange).toHaveBeenCalledTimes(1);
    const newRanges = onChange.mock.calls[0][0] as ColorRange[];
    // Should have one more range than before
    expect(newRanges.length).toBe(4);
  });

  it('add button is disabled when at maxRanges', () => {
    render(
      <RangeColorMapping ranges={defaultRanges} onChange={onChange} maxRanges={3} />,
    );

    const addBtn = screen.getByTestId('add-range-btn');
    expect(addBtn.hasAttribute('disabled')).toBe(true);

    fireEvent.click(addBtn);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('remove button deletes a range', () => {
    render(
      <RangeColorMapping ranges={defaultRanges} onChange={onChange} />,
    );

    const removeBtns = screen.getAllByTestId('remove-range-btn');
    // Remove the second range (index 1)
    fireEvent.click(removeBtns[1]);

    expect(onChange).toHaveBeenCalledTimes(1);
    const remaining = onChange.mock.calls[0][0] as ColorRange[];
    expect(remaining.length).toBe(2);
    // Should have removed the yellow (30-70) range
    expect(remaining[0].fill).toBe('#22c55e');
    expect(remaining[1].fill).toBe('#ef4444');
  });

  it('validates min < max by showing error styling', () => {
    const invalidRanges: ColorRange[] = [
      { min: 50, max: 30, fill: '#ef4444' }, // min > max = invalid
    ];

    const { container } = render(
      <RangeColorMapping ranges={invalidRanges} onChange={onChange} />,
    );

    // The row should have error styling (red background)
    const row = container.querySelector('[data-testid="range-row"]');
    expect(row?.className).toContain('bg-red-50');

    // Validation banner should appear
    const banner = container.querySelector('.bg-amber-50');
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toContain('Min must be less than Max');
  });

  it('sorts ranges by min value when adding new range', () => {
    const unsortedRanges: ColorRange[] = [
      { min: 70, max: 100, fill: '#ef4444' },
      { min: 0, max: 30, fill: '#22c55e' },
    ];

    render(
      <RangeColorMapping ranges={unsortedRanges} onChange={onChange} />,
    );

    const addBtn = screen.getByTestId('add-range-btn');
    fireEvent.click(addBtn);

    expect(onChange).toHaveBeenCalledTimes(1);
    const sorted = onChange.mock.calls[0][0] as ColorRange[];
    // New range (default min=0) should sort to the beginning
    expect(sorted[0].min).toBeLessThanOrEqual(sorted[1].min);
    expect(sorted[1].min).toBeLessThanOrEqual(sorted[2].min);
  });

  it('renders stroke color picker when showStroke is true', () => {
    const rangesWithStroke: ColorRange[] = [
      { min: 0, max: 100, fill: '#22c55e', stroke: '#16a34a' },
    ];

    const { container } = render(
      <RangeColorMapping ranges={rangesWithStroke} onChange={onChange} showStroke />,
    );

    // Should have two color inputs (fill + stroke) per row
    const colorInputs = container.querySelectorAll('input[type="color"]');
    expect(colorInputs.length).toBe(2);
  });

  it('renders label input when showLabel is true', () => {
    const rangesWithLabel: ColorRange[] = [
      { min: 0, max: 50, fill: '#22c55e', label: 'Normal' },
    ];

    render(
      <RangeColorMapping ranges={rangesWithLabel} onChange={onChange} showLabel />,
    );

    const labelInput = screen.getByDisplayValue('Normal');
    expect(labelInput).toBeDefined();
  });
});

/* ================================================================== */
/*  ColorRange interface structural test                               */
/* ================================================================== */

describe('ColorRange interface', () => {
  it('has required min, max, fill fields and optional stroke/label', () => {
    // Compile-time type assertion: this test verifies the interface contract.
    // If ColorRange changes structure, this test will fail to compile.
    const range: ColorRange = {
      min: 0,
      max: 100,
      fill: '#22c55e',
    };

    expect(range.min).toBe(0);
    expect(range.max).toBe(100);
    expect(range.fill).toBe('#22c55e');
    expect(range.stroke).toBeUndefined();
    expect(range.label).toBeUndefined();

    // Optional fields
    const rangeWithOptionals: ColorRange = {
      min: 50,
      max: 75,
      fill: '#eab308',
      stroke: '#ca8a04',
      label: 'Warning',
    };

    expect(rangeWithOptionals.stroke).toBe('#ca8a04');
    expect(rangeWithOptionals.label).toBe('Warning');
  });
});
