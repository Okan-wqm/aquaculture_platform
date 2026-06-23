/**
 * Phase 7A SVG Tag Binding + Animation Rendering Fixes tests.
 *
 * Covers:
 *   1.  SvgTagBindingSection renders TagBrowser when expanded
 *   2.  SvgRectConfig includes SvgTagBindingSection
 *   3.  SvgEllipseConfig includes SvgTagBindingSection
 *   4.  CustomSvgConfig includes TransformConfig
 *   5.  SvgRectRenderer renders fillLevel overlay at correct height
 *   6.  SvgCircleRenderer renders fillLevel with clipPath
 *   7.  Blink with configured colors alternates fill (not opacity)
 *   8.  Blink without colors falls back to opacity fade
 *   9.  recursiveColor CSS variables override fill in renderer
 *  10.  SvgPathRenderer renders SvgGradientDefs when gradient configured
 *  11.  SvgPathConfig shows GradientEditor when closed path
 *  12.  RasterImageConfig includes SvgTagBindingSection
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* ------------------------------------------------------------------ */
/*  Mocks: TagBrowser relies on useDeviceTags which hits the API.     */
/*  We mock the entire TagBrowser to isolate component-level tests.   */
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

/* ------------------------------------------------------------------ */
/*  Imports (after mocks so TagBrowser is already stubbed)             */
/* ------------------------------------------------------------------ */

import { SvgTagBindingSection } from '../components/scada-builder/widget-configs/SvgTagBindingSection';
import { SvgRectConfig } from '../components/scada-builder/widget-configs/SvgShapeConfig';
import { SvgEllipseConfig } from '../components/scada-builder/widget-configs/SvgEllipseConfig';
import { CustomSvgConfig } from '../components/scada-builder/widget-configs/CustomSvgConfig';
import { SvgPathConfig } from '../components/scada-builder/widget-configs/SvgPathConfig';
import { RasterImageConfig } from '../components/scada-builder/widget-configs/RasterImageConfig';
import type { AnimationState } from '../engine/animation/types';
import { DEFAULT_ANIMATION_STATE } from '../engine/animation/types';

// Lazy renderers cannot be imported directly with React.lazy -- we import them directly
 
const SvgRectRenderer = (await import('../components/scada-builder/widget-renderers/SvgRectRenderer')).default;
const SvgCircleRenderer = (await import('../components/scada-builder/widget-renderers/SvgCircleRenderer')).default;
const SvgPathRenderer = (await import('../components/scada-builder/widget-renderers/SvgPathRenderer')).default;

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function makeConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fill: '#3b82f6',
    stroke: '#1d4ed8',
    strokeWidth: 2,
    opacity: 1,
    _widgetId: 'test-widget',
    ...overrides,
  };
}

function makeAnimationState(overrides: Partial<AnimationState> = {}): AnimationState {
  return {
    ...DEFAULT_ANIMATION_STATE,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  1. SvgTagBindingSection renders TagBrowser when expanded           */
/* ------------------------------------------------------------------ */

describe('SvgTagBindingSection', () => {
  it('1. renders TagBrowser when section is expanded', () => {
    const onChange = vi.fn();
    render(
      <SvgTagBindingSection tagName="" onChange={onChange} deviceId="device-1" />,
    );

    // Section starts collapsed when no tag is bound -- click to expand
    const toggle = screen.getByLabelText('Data binding settings');
    fireEvent.click(toggle);

    // TagBrowser should now be visible
    const tagBrowser = screen.getByTestId('tag-browser');
    expect(tagBrowser).toBeDefined();
    expect(tagBrowser.getAttribute('data-device-id')).toBe('device-1');
  });

  it('1b. shows TagBrowser already expanded when tagName is set', () => {
    const onChange = vi.fn();
    render(
      <SvgTagBindingSection tagName="temperature.value" onChange={onChange} deviceId="device-1" />,
    );

    // Should be auto-expanded because tagName is set
    const tagBrowser = screen.getByTestId('tag-browser');
    expect(tagBrowser).toBeDefined();
    expect(tagBrowser.getAttribute('data-value')).toBe('temperature.value');
  });
});

/* ------------------------------------------------------------------ */
/*  2. SvgRectConfig includes SvgTagBindingSection                    */
/* ------------------------------------------------------------------ */

describe('SvgRectConfig', () => {
  it('2. includes SvgTagBindingSection', () => {
    const onChange = vi.fn();
    render(
      <SvgRectConfig config={{ tagName: 'ph.value' }} onChange={onChange} deviceId="d1" />,
    );

    // The binding section should be present (auto-expanded because tagName is set)
    const section = screen.getByTestId('svg-tag-binding-section');
    expect(section).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/*  3. SvgEllipseConfig includes SvgTagBindingSection                 */
/* ------------------------------------------------------------------ */

describe('SvgEllipseConfig', () => {
  it('3. includes SvgTagBindingSection', () => {
    const onChange = vi.fn();
    render(
      <SvgEllipseConfig config={{ tagName: 'do.value' }} onChange={onChange} deviceId="d2" />,
    );

    const section = screen.getByTestId('svg-tag-binding-section');
    expect(section).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/*  4. CustomSvgConfig includes TransformConfig                       */
/* ------------------------------------------------------------------ */

describe('CustomSvgConfig', () => {
  it('4. includes TransformConfig section', () => {
    const onChange = vi.fn();
    render(
      <CustomSvgConfig config={{}} onChange={onChange} />,
    );

    // TransformConfig renders a collapsible section with aria-label
    const transformToggle = screen.getByLabelText('Transform settings');
    expect(transformToggle).toBeDefined();
  });

  it('4b. includes opacity slider', () => {
    const onChange = vi.fn();
    render(
      <CustomSvgConfig config={{ opacity: 0.7 }} onChange={onChange} />,
    );

    const opacitySlider = screen.getByLabelText('SVG opacity');
    expect(opacitySlider).toBeDefined();
  });

  it('4c. includes SvgTagBindingSection', () => {
    const onChange = vi.fn();
    render(
      <CustomSvgConfig config={{}} onChange={onChange} deviceId="d3" />,
    );

    const section = screen.getByTestId('svg-tag-binding-section');
    expect(section).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/*  5. SvgRectRenderer renders fillLevel overlay at correct height    */
/* ------------------------------------------------------------------ */

describe('SvgRectRenderer fillLevel', () => {
  it('5. renders fill level overlay when fillPercent is set', () => {
    const config = makeConfig();
    const anim = makeAnimationState({ fillPercent: 60, fillColor: '#00ff00' });

    const { container } = render(
      <SvgRectRenderer
        config={config}
        width={100}
        height={200}
        isEditing={false}
        animationState={anim}
      />,
    );

    // Should have a fill-level-overlay element
    const overlay = container.querySelector('[data-testid="fill-level-overlay"]');
    expect(overlay).not.toBeNull();

    // Should have a clipPath defined
    const clipPath = container.querySelector('clipPath');
    expect(clipPath).not.toBeNull();
  });

  it('5b. does not render fill level when fillPercent is undefined', () => {
    const config = makeConfig();
    const anim = makeAnimationState();

    const { container } = render(
      <SvgRectRenderer
        config={config}
        width={100}
        height={200}
        isEditing={false}
        animationState={anim}
      />,
    );

    const overlay = container.querySelector('[data-testid="fill-level-overlay"]');
    expect(overlay).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  6. SvgCircleRenderer renders fillLevel with clipPath              */
/* ------------------------------------------------------------------ */

describe('SvgCircleRenderer fillLevel', () => {
  it('6. renders fill level with clipPath when fillPercent is set', () => {
    const config = makeConfig();
    const anim = makeAnimationState({ fillPercent: 75, fillColor: '#ff0000' });

    const { container } = render(
      <SvgCircleRenderer
        config={config}
        width={100}
        height={100}
        isEditing={false}
        animationState={anim}
      />,
    );

    const overlay = container.querySelector('[data-testid="fill-level-overlay"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.tagName.toLowerCase()).toBe('ellipse');

    const clipPath = container.querySelector('clipPath');
    expect(clipPath).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  7. Blink with configured colors alternates fill (not opacity)     */
/* ------------------------------------------------------------------ */

describe('Color blink animation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('7. alternates fill color between blinkFillA and blinkFillB', () => {
    const config = makeConfig();
    const anim = makeAnimationState({
      blinking: true,
      blinkInterval: 1000,
      blinkFillA: '#ff0000',
      blinkFillB: '#00ff00',
    });

    const { container } = render(
      <SvgRectRenderer
        config={config}
        width={100}
        height={100}
        isEditing={false}
        animationState={anim}
      />,
    );

    // Initial state: should show blinkFillA
    const rect = container.querySelector('rect:not([data-testid])');
    expect(rect).not.toBeNull();
    const initialFill = rect?.getAttribute('fill');
    expect(initialFill).toBe('#ff0000');

    // Advance timer to trigger blink phase change (interval/2 = 500ms)
    act(() => {
      vi.advanceTimersByTime(500);
    });

    // Should now show blinkFillB
    const updatedFill = rect?.getAttribute('fill');
    expect(updatedFill).toBe('#00ff00');

    // SVG element should NOT have opacity-based animation
    const svgEl = container.querySelector('svg');
    const svgStyle = svgEl?.getAttribute('style') || svgEl?.style.animation || '';
    expect(svgStyle).not.toContain('scada-blink');
  });
});

/* ------------------------------------------------------------------ */
/*  8. Blink without colors falls back to opacity fade                */
/* ------------------------------------------------------------------ */

describe('Opacity blink fallback', () => {
  it('8. uses opacity animation when blinkFillA/B are not set', () => {
    const config = makeConfig();
    const anim = makeAnimationState({
      blinking: true,
      blinkInterval: 500,
    });

    const { container } = render(
      <SvgRectRenderer
        config={config}
        width={100}
        height={100}
        isEditing={false}
        animationState={anim}
      />,
    );

    // Should have scada-blink CSS animation on the SVG element
    const svgEl = container.querySelector('svg');
    expect(svgEl).not.toBeNull();

    // Check inline style for scada-blink animation
    const animationStyle = svgEl?.style.animation || '';
    expect(animationStyle).toContain('scada-blink');
  });
});

/* ------------------------------------------------------------------ */
/*  9. recursiveColor CSS variables override fill in renderer         */
/* ------------------------------------------------------------------ */

describe('recursiveColor CSS variable override', () => {
  it('9. uses cssVariables[--scada-fill] as fill override', () => {
    const config = makeConfig({ fill: '#3b82f6' });
    const anim = makeAnimationState({
      cssVariables: { '--scada-fill': '#ff00ff' },
    });

    const { container } = render(
      <SvgRectRenderer
        config={config}
        width={100}
        height={100}
        isEditing={false}
        animationState={anim}
      />,
    );

    // The rect should use the CSS variable color, not the config color
    const rects = container.querySelectorAll('rect');
    const mainRect = rects[rects.length - 1];
    expect(mainRect?.getAttribute('fill')).toBe('#ff00ff');
  });

  it('9b. animationState.fill has higher priority than cssVariables', () => {
    const config = makeConfig({ fill: '#3b82f6' });
    const anim = makeAnimationState({
      fill: '#00ff00',
      cssVariables: { '--scada-fill': '#ff00ff' },
    });

    const { container } = render(
      <SvgRectRenderer
        config={config}
        width={100}
        height={100}
        isEditing={false}
        animationState={anim}
      />,
    );

    const rects = container.querySelectorAll('rect');
    const mainRect = rects[rects.length - 1];
    // animationState.fill should win over cssVariables
    expect(mainRect?.getAttribute('fill')).toBe('#00ff00');
  });
});

/* ------------------------------------------------------------------ */
/* 10. SvgPathRenderer renders SvgGradientDefs when gradient config   */
/* ------------------------------------------------------------------ */

describe('SvgPathRenderer gradient support', () => {
  it('10. renders gradient defs when closed path has gradient', () => {
    const config = makeConfig({
      points: [
        { x: 50, y: 10, type: 'line' },
        { x: 90, y: 80, type: 'line' },
        { x: 10, y: 80, type: 'line' },
      ],
      closed: true,
      fill: '#3b82f6',
      fillGradient: {
        type: 'linear',
        angle: 90,
        stops: [
          { offset: 0, color: '#ff0000', opacity: 1 },
          { offset: 1, color: '#0000ff', opacity: 1 },
        ],
      },
    });

    const { container } = render(
      <SvgPathRenderer
        config={config}
        width={100}
        height={100}
        isEditing={false}
      />,
    );

    // Should have a linearGradient definition
    const linearGrad = container.querySelector('linearGradient');
    expect(linearGrad).not.toBeNull();

    // Path fill should reference the gradient URL
    const path = container.querySelector('path');
    expect(path?.getAttribute('fill')).toContain('url(#');
  });
});

/* ------------------------------------------------------------------ */
/* 11. SvgPathConfig shows GradientEditor when closed path            */
/* ------------------------------------------------------------------ */

describe('SvgPathConfig', () => {
  it('11. shows GradientEditor when path is closed', () => {
    const onChange = vi.fn();
    render(
      <SvgPathConfig config={{ closed: true, points: [] }} onChange={onChange} />,
    );

    // GradientEditor has a collapsible section labeled "Gradient"
    const gradientToggle = screen.getByLabelText('Gradient settings');
    expect(gradientToggle).toBeDefined();
  });

  it('11b. hides GradientEditor when path is open', () => {
    const onChange = vi.fn();
    render(
      <SvgPathConfig config={{ closed: false, points: [] }} onChange={onChange} />,
    );

    // GradientEditor should not be present when path is open
    const gradientToggle = screen.queryByLabelText('Gradient settings');
    expect(gradientToggle).toBeNull();
  });

  it('11c. shows SvgFilterEditor', () => {
    const onChange = vi.fn();
    render(
      <SvgPathConfig config={{ closed: false, points: [] }} onChange={onChange} />,
    );

    // SvgFilterEditor has a collapsible section labeled "Filter settings"
    const filterToggle = screen.getByLabelText('Filter settings');
    expect(filterToggle).toBeDefined();
  });

  it('11d. includes SvgTagBindingSection', () => {
    const onChange = vi.fn();
    render(
      <SvgPathConfig config={{}} onChange={onChange} deviceId="d4" />,
    );

    const section = screen.getByTestId('svg-tag-binding-section');
    expect(section).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/* 12. RasterImageConfig includes SvgTagBindingSection                */
/* ------------------------------------------------------------------ */

describe('RasterImageConfig', () => {
  it('12. includes SvgTagBindingSection', () => {
    const onChange = vi.fn();
    render(
      <RasterImageConfig config={{}} onChange={onChange} deviceId="d5" />,
    );

    const section = screen.getByTestId('svg-tag-binding-section');
    expect(section).toBeDefined();
  });
});
