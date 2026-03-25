/**
 * Phase 6 Gradient, Filter, and Advanced SVG tests.
 *
 * Covers:
 *   1.  GradientEditor renders type selector (none/linear/radial)
 *   2.  GradientEditor shows angle input for linear type
 *   3.  GradientEditor gradient preview bar renders
 *   4.  GradientEditor adds stop on add button click
 *   5.  GradientEditor enforces minimum 2 stops
 *   6.  GradientEditor stop color change updates gradient
 *   7.  ColorAlphaInput renders color swatch and alpha slider
 *   8.  ColorAlphaInput outputs correct color and alpha values
 *   9.  SvgFilterEditor renders filter type selector
 *  10.  SvgFilterEditor shows blur radius for blur type
 *  11.  SvgFilterEditor shows shadow params for dropShadow type
 *  12.  SvgGradientDefs renders linearGradient for linear type
 *  13.  SvgGradientDefs renders radialGradient for radial type
 *  14.  SvgGradientDefs renders filter element for blur
 *  15.  buildGradientId generates unique IDs
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { GradientEditor } from '../components/scada-builder/widget-configs/GradientEditor';
import { ColorAlphaInput } from '../components/scada-builder/widget-configs/ColorAlphaInput';
import { SvgFilterEditor } from '../components/scada-builder/widget-configs/SvgFilterEditor';
import SvgGradientDefs from '../components/scada-builder/widget-configs/SvgGradientDefs';
import {
  buildGradientId,
  buildFilterId,
  type GradientConfig,
  type SvgFilterConfig,
  DEFAULT_GRADIENT,
} from '../types/scada-svg-properties.types';

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Creates a linear gradient config for testing */
function makeLinearGradient(overrides: Partial<GradientConfig> = {}): GradientConfig {
  return {
    type: 'linear',
    angle: 90,
    stops: [
      { offset: 0, color: '#ff0000', opacity: 1 },
      { offset: 1, color: '#0000ff', opacity: 1 },
    ],
    ...overrides,
  };
}

/** Creates a radial gradient config for testing */
function makeRadialGradient(): GradientConfig {
  return {
    type: 'radial',
    angle: 0,
    stops: [
      { offset: 0, color: '#ffffff', opacity: 1 },
      { offset: 1, color: '#000000', opacity: 1 },
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  GradientEditor                                                      */
/* ------------------------------------------------------------------ */

describe('GradientEditor', () => {
  it('1. renders type selector with none/linear/radial options', () => {
    const onChange = vi.fn();
    render(
      <GradientEditor
        gradient={makeLinearGradient()}
        onChange={onChange}
        widgetId="test-1"
      />,
    );

    // The collapsible section should be open because type is not 'none'
    expect(screen.getByText('None')).toBeDefined();
    expect(screen.getByText('Linear')).toBeDefined();
    expect(screen.getByText('Radial')).toBeDefined();
  });

  it('2. shows angle input for linear type', () => {
    const onChange = vi.fn();
    render(
      <GradientEditor
        gradient={makeLinearGradient({ angle: 45 })}
        onChange={onChange}
        widgetId="test-2"
      />,
    );

    const angleInput = screen.getByLabelText('Gradient angle');
    expect(angleInput).toBeDefined();
    expect((angleInput as HTMLInputElement).value).toBe('45');
  });

  it('3. gradient preview bar renders', () => {
    const onChange = vi.fn();
    render(
      <GradientEditor
        gradient={makeLinearGradient()}
        onChange={onChange}
        widgetId="test-3"
      />,
    );

    const preview = screen.getByLabelText('Gradient preview');
    expect(preview).toBeDefined();
    expect(preview.tagName.toLowerCase()).toBe('svg');
  });

  it('4. adds stop on add button click', () => {
    const onChange = vi.fn();
    render(
      <GradientEditor
        gradient={makeLinearGradient()}
        onChange={onChange}
        widgetId="test-4"
      />,
    );

    const addBtn = screen.getByTestId('add-stop');
    fireEvent.click(addBtn);

    expect(onChange).toHaveBeenCalledTimes(1);
    const newGradient = onChange.mock.calls[0][0] as GradientConfig;
    // Should have 3 stops now (was 2)
    expect(newGradient.stops).toHaveLength(3);
  });

  it('5. enforces minimum 2 stops by hiding remove button', () => {
    const onChange = vi.fn();
    render(
      <GradientEditor
        gradient={makeLinearGradient()}
        onChange={onChange}
        widgetId="test-5"
      />,
    );

    // With exactly 2 stops, the remove button should not be present
    const removeBtn = screen.queryByTestId('remove-stop');
    expect(removeBtn).toBeNull();
  });

  it('6. stop color change updates gradient via ColorAlphaInput', () => {
    const onChange = vi.fn();
    render(
      <GradientEditor
        gradient={makeLinearGradient()}
        onChange={onChange}
        widgetId="test-6"
      />,
    );

    // Click the first stop to select it
    const stop0 = screen.getByTestId('gradient-stop-0');
    fireEvent.click(stop0);

    // Find the color swatch in the stop editor and change it
    const swatches = screen.getAllByTestId('color-swatch');
    // The last swatch should be in the stop editor panel
    const stopSwatch = swatches[swatches.length - 1];
    fireEvent.change(stopSwatch, { target: { value: '#00ff00' } });

    expect(onChange).toHaveBeenCalled();
    const updated = onChange.mock.calls[0][0] as GradientConfig;
    expect(updated.stops[0].color).toBe('#00ff00');
  });
});

/* ------------------------------------------------------------------ */
/*  ColorAlphaInput                                                     */
/* ------------------------------------------------------------------ */

describe('ColorAlphaInput', () => {
  it('7. renders color swatch and alpha slider', () => {
    const onChange = vi.fn();
    render(
      <ColorAlphaInput color="#ff0000" alpha={0.8} onChange={onChange} label="Test" />,
    );

    expect(screen.getByTestId('color-swatch')).toBeDefined();
    expect(screen.getByTestId('alpha-slider')).toBeDefined();
    expect(screen.getByTestId('color-hex-input')).toBeDefined();
    expect(screen.getByTestId('alpha-percent')).toBeDefined();
  });

  it('8. outputs correct color and alpha values on slider change', () => {
    const onChange = vi.fn();
    render(
      <ColorAlphaInput color="#ff0000" alpha={1} onChange={onChange} />,
    );

    const slider = screen.getByTestId('alpha-slider');
    fireEvent.change(slider, { target: { value: '0.5' } });

    expect(onChange).toHaveBeenCalledWith('#ff0000', 0.5);
  });
});

/* ------------------------------------------------------------------ */
/*  SvgFilterEditor                                                     */
/* ------------------------------------------------------------------ */

describe('SvgFilterEditor', () => {
  it('9. renders filter type selector', () => {
    const onChange = vi.fn();
    const filter: SvgFilterConfig = { type: 'none' };
    render(
      <SvgFilterEditor filter={filter} onChange={onChange} widgetId="test-9" />,
    );

    // Click to expand
    const toggle = screen.getByLabelText('Filter settings');
    fireEvent.click(toggle);

    const select = screen.getByTestId('filter-type-select');
    expect(select).toBeDefined();
    // Should have all 4 options
    const options = within(select).getAllByRole('option');
    expect(options).toHaveLength(4);
  });

  it('10. shows blur radius for blur type', () => {
    const onChange = vi.fn();
    const filter: SvgFilterConfig = { type: 'blur', blurRadius: 8 };
    render(
      <SvgFilterEditor filter={filter} onChange={onChange} widgetId="test-10" />,
    );

    const blurSlider = screen.getByTestId('blur-radius');
    expect(blurSlider).toBeDefined();
    expect((blurSlider as HTMLInputElement).value).toBe('8');
  });

  it('11. shows shadow params for dropShadow type', () => {
    const onChange = vi.fn();
    const filter: SvgFilterConfig = {
      type: 'dropShadow',
      blurRadius: 4,
      shadowX: 3,
      shadowY: 5,
      shadowColor: '#000000',
      shadowOpacity: 0.6,
    };
    render(
      <SvgFilterEditor filter={filter} onChange={onChange} widgetId="test-11" />,
    );

    expect(screen.getByTestId('shadow-blur-radius')).toBeDefined();
    expect(screen.getByTestId('shadow-x')).toBeDefined();
    expect(screen.getByTestId('shadow-y')).toBeDefined();

    const xInput = screen.getByTestId('shadow-x') as HTMLInputElement;
    expect(xInput.value).toBe('3');

    const yInput = screen.getByTestId('shadow-y') as HTMLInputElement;
    expect(yInput.value).toBe('5');
  });
});

/* ------------------------------------------------------------------ */
/*  SvgGradientDefs                                                     */
/* ------------------------------------------------------------------ */

describe('SvgGradientDefs', () => {
  it('12. renders linearGradient for linear type', () => {
    const { container } = render(
      <svg>
        <SvgGradientDefs
          widgetId="w-12"
          fillGradient={makeLinearGradient()}
        />
      </svg>,
    );

    const linearGrad = container.querySelector('linearGradient');
    expect(linearGrad).not.toBeNull();
    expect(linearGrad?.id).toBe(buildGradientId('w-12', 'fill'));

    // Should have 2 stop elements
    const stops = linearGrad?.querySelectorAll('stop');
    expect(stops?.length).toBe(2);
  });

  it('13. renders radialGradient for radial type', () => {
    const { container } = render(
      <svg>
        <SvgGradientDefs
          widgetId="w-13"
          fillGradient={makeRadialGradient()}
        />
      </svg>,
    );

    const radialGrad = container.querySelector('radialGradient');
    expect(radialGrad).not.toBeNull();
    expect(radialGrad?.id).toBe(buildGradientId('w-13', 'fill'));
  });

  it('14. renders filter element for blur', () => {
    const filter: SvgFilterConfig = { type: 'blur', blurRadius: 5 };
    const { container } = render(
      <svg>
        <SvgGradientDefs
          widgetId="w-14"
          filter={filter}
        />
      </svg>,
    );

    const filterEl = container.querySelector('filter');
    expect(filterEl).not.toBeNull();
    expect(filterEl?.id).toBe(buildFilterId('w-14'));

    // Should contain feGaussianBlur
    const gaussianBlur = filterEl?.querySelector('feGaussianBlur');
    expect(gaussianBlur).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  buildGradientId                                                     */
/* ------------------------------------------------------------------ */

describe('buildGradientId', () => {
  it('15. generates unique IDs for different widgets and targets', () => {
    const id1 = buildGradientId('widget-a', 'fill');
    const id2 = buildGradientId('widget-a', 'stroke');
    const id3 = buildGradientId('widget-b', 'fill');

    expect(id1).toBe('grad-widget-a-fill');
    expect(id2).toBe('grad-widget-a-stroke');
    expect(id3).toBe('grad-widget-b-fill');

    // All unique
    expect(id1).not.toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id2).not.toBe(id3);
  });
});
