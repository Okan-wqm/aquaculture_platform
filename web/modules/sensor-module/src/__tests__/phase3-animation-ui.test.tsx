/**
 * Phase 3B animation panel UI tests — verifies the extended AnimationsPanel
 * with all 12 animation types, type-specific config inputs, default values,
 * and the animation preview mode.
 *
 * Covers:
 *   1.  AnimationsPanel shows all 12 animation type options in dropdown
 *   2.  Selecting 'valueMappedRotation' shows minAngle/maxAngle inputs
 *   3.  Selecting 'piston' shows distance/duration inputs
 *   4.  Selecting 'imageAlongPath' shows motionPath textarea
 *   5.  Selecting 'recursiveColor' shows RangeColorMapping
 *   6.  Selecting 'scale' shows minScale/maxScale inputs
 *   7.  Preview toggle button renders
 *   8.  Preview slider appears when preview is active
 *   9.  Default option values are populated correctly
 *  10.  Changing option values calls onChange with updated rule
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AnimationRule, AnimationRuleType } from '../engine/animation/types';

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

/**
 * TagBrowser mock — isolates the panel from network-dependent device
 * tag discovery. Renders a simple input mirroring the real interface.
 */
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

/**
 * RangeColorMapping mock — verifies the component is rendered by
 * recursiveColor type without testing its internal behavior (covered
 * by phase1.5-tagbrowser.test.tsx).
 */
vi.mock('../components/scada-builder/widget-configs/RangeColorMapping', () => ({
  RangeColorMapping: ({
    ranges,
    onChange,
  }: {
    ranges: Array<{ min: number; max: number; fill: string }>;
    onChange: (ranges: Array<{ min: number; max: number; fill: string }>) => void;
  }) => (
    <div data-testid="range-color-mapping" data-range-count={ranges.length}>
      <button
        data-testid="rcm-add-btn"
        onClick={() => onChange([...ranges, { min: 0, max: 100, fill: '#000' }])}
      >
        Add
      </button>
    </div>
  ),
}));

/* ------------------------------------------------------------------ */
/*  Imports (after mocks)                                              */
/* ------------------------------------------------------------------ */

import { AnimationsPanel } from '../components/scada-builder/widget-configs/AnimationsPanel';

/* ------------------------------------------------------------------ */
/*  Helper: create an animation rule with a specific type              */
/* ------------------------------------------------------------------ */

function makeAnimationRule(
  type: AnimationRuleType,
  overrides: Partial<AnimationRule> = {},
): AnimationRule {
  return {
    id: 'test-anim-1',
    tagName: 'sensor.temperature',
    range: { min: 0, max: 100 },
    type,
    options: {},
    ...overrides,
  };
}

/* ================================================================== */
/*  Tests                                                              */
/* ================================================================== */

describe('AnimationsPanel — Extended Animation Types', () => {
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChange = vi.fn();
  });

  /* -------------------------------------------------------------- */
  /*  1. All 12 animation type options in dropdown                   */
  /* -------------------------------------------------------------- */

  it('shows all 12 animation type options in the dropdown', () => {
    const anim = makeAnimationRule('colorRange');
    const { container } = render(
      <AnimationsPanel animations={[anim]} onChange={onChange} />,
    );

    const select = container.querySelector('[data-testid="animation-type-select"]') as HTMLSelectElement;
    expect(select).toBeTruthy();

    const options = Array.from(select.querySelectorAll('option'));
    expect(options).toHaveLength(12);

    const values = options.map((opt) => opt.value);
    expect(values).toEqual([
      'colorRange',
      'rotate',
      'blink',
      'hide',
      'show',
      'fillLevel',
      'move',
      'valueMappedRotation',
      'piston',
      'imageAlongPath',
      'recursiveColor',
      'scale',
    ]);
  });

  /* -------------------------------------------------------------- */
  /*  2. valueMappedRotation shows minAngle/maxAngle inputs          */
  /* -------------------------------------------------------------- */

  it('shows minAngle and maxAngle inputs for valueMappedRotation', () => {
    const anim = makeAnimationRule('valueMappedRotation');
    const { container } = render(
      <AnimationsPanel animations={[anim]} onChange={onChange} />,
    );

    const config = container.querySelector('[data-testid="value-mapped-rotation-config"]');
    expect(config).toBeTruthy();

    const minAngle = container.querySelector('[data-testid="min-angle-input"]') as HTMLInputElement;
    const maxAngle = container.querySelector('[data-testid="max-angle-input"]') as HTMLInputElement;
    expect(minAngle).toBeTruthy();
    expect(maxAngle).toBeTruthy();
  });

  /* -------------------------------------------------------------- */
  /*  3. piston shows distance/duration inputs                       */
  /* -------------------------------------------------------------- */

  it('shows distance and duration inputs for piston', () => {
    const anim = makeAnimationRule('piston');
    const { container } = render(
      <AnimationsPanel animations={[anim]} onChange={onChange} />,
    );

    const config = container.querySelector('[data-testid="piston-config"]');
    expect(config).toBeTruthy();

    const distance = container.querySelector('[data-testid="piston-distance-input"]') as HTMLInputElement;
    const duration = container.querySelector('[data-testid="piston-duration-input"]') as HTMLInputElement;
    expect(distance).toBeTruthy();
    expect(duration).toBeTruthy();
  });

  /* -------------------------------------------------------------- */
  /*  4. imageAlongPath shows motionPath textarea                    */
  /* -------------------------------------------------------------- */

  it('shows motionPath textarea for imageAlongPath', () => {
    const anim = makeAnimationRule('imageAlongPath');
    const { container } = render(
      <AnimationsPanel animations={[anim]} onChange={onChange} />,
    );

    const config = container.querySelector('[data-testid="image-along-path-config"]');
    expect(config).toBeTruthy();

    const textarea = container.querySelector('[data-testid="motion-path-textarea"]') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.tagName.toLowerCase()).toBe('textarea');
    expect(textarea.placeholder).toContain('M 0,50');
  });

  /* -------------------------------------------------------------- */
  /*  5. recursiveColor shows RangeColorMapping                      */
  /* -------------------------------------------------------------- */

  it('shows RangeColorMapping for recursiveColor', () => {
    const anim = makeAnimationRule('recursiveColor');
    const { container } = render(
      <AnimationsPanel animations={[anim]} onChange={onChange} />,
    );

    const config = container.querySelector('[data-testid="recursive-color-config"]');
    expect(config).toBeTruthy();

    const rcm = container.querySelector('[data-testid="range-color-mapping"]');
    expect(rcm).toBeTruthy();

    // CSS variable input should also be present
    const varInput = container.querySelector('[data-testid="color-variable-input"]') as HTMLInputElement;
    expect(varInput).toBeTruthy();
  });

  /* -------------------------------------------------------------- */
  /*  6. scale shows minScale/maxScale inputs                        */
  /* -------------------------------------------------------------- */

  it('shows minScale and maxScale inputs for scale', () => {
    const anim = makeAnimationRule('scale');
    const { container } = render(
      <AnimationsPanel animations={[anim]} onChange={onChange} />,
    );

    const config = container.querySelector('[data-testid="scale-config"]');
    expect(config).toBeTruthy();

    const minScale = container.querySelector('[data-testid="min-scale-input"]') as HTMLInputElement;
    const maxScale = container.querySelector('[data-testid="max-scale-input"]') as HTMLInputElement;
    expect(minScale).toBeTruthy();
    expect(maxScale).toBeTruthy();
  });

  /* -------------------------------------------------------------- */
  /*  7. Preview toggle button renders                               */
  /* -------------------------------------------------------------- */

  it('renders preview toggle button when animations exist', () => {
    const anim = makeAnimationRule('colorRange');
    const { container } = render(
      <AnimationsPanel animations={[anim]} onChange={onChange} />,
    );

    const previewBtn = container.querySelector('[data-testid="preview-toggle"]');
    expect(previewBtn).toBeTruthy();
    expect(previewBtn?.textContent).toContain('Preview');
  });

  it('does not render preview toggle when no animations exist', () => {
    const { container } = render(
      <AnimationsPanel animations={[]} onChange={onChange} />,
    );

    const previewBtn = container.querySelector('[data-testid="preview-toggle"]');
    expect(previewBtn).toBeFalsy();
  });

  /* -------------------------------------------------------------- */
  /*  8. Preview slider appears when preview is active               */
  /* -------------------------------------------------------------- */

  it('shows preview slider when preview is active and animation is focused', () => {
    const anim = makeAnimationRule('rotate');
    const { container } = render(
      <AnimationsPanel animations={[anim]} onChange={onChange} />,
    );

    // Click preview toggle to activate
    const previewBtn = container.querySelector('[data-testid="preview-toggle"]') as HTMLButtonElement;
    fireEvent.click(previewBtn);

    // Click on the animation card to focus it
    const animCard = container.querySelector('.p-3.bg-gray-50') as HTMLElement;
    fireEvent.click(animCard);

    const sliderContainer = container.querySelector('[data-testid="preview-slider-container"]');
    expect(sliderContainer).toBeTruthy();

    const slider = container.querySelector('[data-testid="preview-slider"]') as HTMLInputElement;
    expect(slider).toBeTruthy();
    expect(slider.type).toBe('range');
  });

  /* -------------------------------------------------------------- */
  /*  9. Default option values are populated correctly               */
  /* -------------------------------------------------------------- */

  it('populates default values for valueMappedRotation', () => {
    const anim = makeAnimationRule('valueMappedRotation');
    const { container } = render(
      <AnimationsPanel animations={[anim]} onChange={onChange} />,
    );

    const minAngle = container.querySelector('[data-testid="min-angle-input"]') as HTMLInputElement;
    const maxAngle = container.querySelector('[data-testid="max-angle-input"]') as HTMLInputElement;
    expect(minAngle.value).toBe('0');
    expect(maxAngle.value).toBe('360');
  });

  it('populates default values for piston', () => {
    const anim = makeAnimationRule('piston');
    const { container } = render(
      <AnimationsPanel animations={[anim]} onChange={onChange} />,
    );

    const distance = container.querySelector('[data-testid="piston-distance-input"]') as HTMLInputElement;
    const duration = container.querySelector('[data-testid="piston-duration-input"]') as HTMLInputElement;
    expect(distance.value).toBe('20');
    expect(duration.value).toBe('1000');
  });

  it('populates default values for imageAlongPath', () => {
    const anim = makeAnimationRule('imageAlongPath');
    const { container } = render(
      <AnimationsPanel animations={[anim]} onChange={onChange} />,
    );

    const duration = container.querySelector('[data-testid="motion-duration-input"]') as HTMLInputElement;
    expect(duration.value).toBe('3000');
  });

  it('populates default values for scale', () => {
    const anim = makeAnimationRule('scale');
    const { container } = render(
      <AnimationsPanel animations={[anim]} onChange={onChange} />,
    );

    const minScale = container.querySelector('[data-testid="min-scale-input"]') as HTMLInputElement;
    const maxScale = container.querySelector('[data-testid="max-scale-input"]') as HTMLInputElement;
    expect(minScale.value).toBe('0.5');
    expect(maxScale.value).toBe('2');
  });

  it('populates default CSS variable name for recursiveColor', () => {
    const anim = makeAnimationRule('recursiveColor');
    const { container } = render(
      <AnimationsPanel animations={[anim]} onChange={onChange} />,
    );

    const varInput = container.querySelector('[data-testid="color-variable-input"]') as HTMLInputElement;
    expect(varInput.value).toBe('--scada-fill');
  });

  /* -------------------------------------------------------------- */
  /*  10. Changing option values calls onChange with updated rule     */
  /* -------------------------------------------------------------- */

  it('calls onChange with updated minAngle when valueMappedRotation input changes', () => {
    const anim = makeAnimationRule('valueMappedRotation');
    const { container } = render(
      <AnimationsPanel animations={[anim]} onChange={onChange} />,
    );

    const minAngle = container.querySelector('[data-testid="min-angle-input"]') as HTMLInputElement;
    fireEvent.change(minAngle, { target: { value: '45' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const updatedRules = onChange.mock.calls[0][0] as AnimationRule[];
    expect(updatedRules).toHaveLength(1);
    expect(updatedRules[0].options.minAngle).toBe(45);
  });

  it('calls onChange with updated pistonDistance when piston input changes', () => {
    const anim = makeAnimationRule('piston');
    const { container } = render(
      <AnimationsPanel animations={[anim]} onChange={onChange} />,
    );

    const distance = container.querySelector('[data-testid="piston-distance-input"]') as HTMLInputElement;
    fireEvent.change(distance, { target: { value: '50' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const updatedRules = onChange.mock.calls[0][0] as AnimationRule[];
    expect(updatedRules[0].options.pistonDistance).toBe(50);
  });

  it('calls onChange with updated motionPath when imageAlongPath textarea changes', () => {
    const anim = makeAnimationRule('imageAlongPath');
    const { container } = render(
      <AnimationsPanel animations={[anim]} onChange={onChange} />,
    );

    const textarea = container.querySelector('[data-testid="motion-path-textarea"]') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'M 0,0 L 100,100' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const updatedRules = onChange.mock.calls[0][0] as AnimationRule[];
    expect(updatedRules[0].options.motionPath).toBe('M 0,0 L 100,100');
  });

  it('calls onChange with updated minScale when scale input changes', () => {
    const anim = makeAnimationRule('scale');
    const { container } = render(
      <AnimationsPanel animations={[anim]} onChange={onChange} />,
    );

    const minScale = container.querySelector('[data-testid="min-scale-input"]') as HTMLInputElement;
    fireEvent.change(minScale, { target: { value: '1.5' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const updatedRules = onChange.mock.calls[0][0] as AnimationRule[];
    expect(updatedRules[0].options.minScale).toBe(1.5);
  });

  it('calls onChange with updated colorVariable when recursiveColor input changes', () => {
    const anim = makeAnimationRule('recursiveColor');
    const { container } = render(
      <AnimationsPanel animations={[anim]} onChange={onChange} />,
    );

    const varInput = container.querySelector('[data-testid="color-variable-input"]') as HTMLInputElement;
    fireEvent.change(varInput, { target: { value: '--primary-color' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const updatedRules = onChange.mock.calls[0][0] as AnimationRule[];
    expect(updatedRules[0].options.colorVariable).toBe('--primary-color');
  });
});

/* ================================================================== */
/*  Dropdown label verification                                       */
/* ================================================================== */

describe('AnimationsPanel — Dropdown Labels', () => {
  it('displays human-readable labels instead of raw type values', () => {
    const anim = makeAnimationRule('colorRange');
    const { container } = render(
      <AnimationsPanel animations={[anim]} onChange={vi.fn()} />,
    );

    const select = container.querySelector('[data-testid="animation-type-select"]') as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll('option'));
    const labels = options.map((opt) => opt.textContent);

    expect(labels).toContain('Color Range');
    expect(labels).toContain('Continuous Rotation');
    expect(labels).toContain('Value-Mapped Rotation');
    expect(labels).toContain('Piston (Vertical Oscillation)');
    expect(labels).toContain('Image Along Path');
    expect(labels).toContain('Recursive Color (CSS Variables)');
    expect(labels).toContain('Value-Mapped Scale');
  });
});
