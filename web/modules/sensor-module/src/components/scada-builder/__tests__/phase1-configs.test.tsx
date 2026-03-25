/**
 * Phase 1C SCADA Builder tests -- shared config panels, marker defs,
 * and image validation.
 *
 * Covers:
 *  1.  TransformConfig renders rotation input
 *  2.  TransformConfig clamps values to safe bounds
 *  3.  TransformConfig origin grid has 9 clickable points
 *  4.  TransformConfig reset button restores defaults
 *  5.  StrokeConfig renders all 5 dash pattern options
 *  6.  StrokeConfig renders line cap radio group
 *  7.  StrokeConfig renders line join radio group
 *  8.  SvgMarkerDefs renders arrow marker path
 *  9.  SvgMarkerDefs generates unique IDs per screen
 *  10. SvgMarkerDefs renders circle/diamond/square shapes
 *  11. RasterImageConfig rejects non-image files
 *  12. RasterImageConfig warns on large file sizes
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransformConfig } from '../widget-configs/TransformConfig';
import { StrokeConfig } from '../widget-configs/StrokeConfig';
import { SvgMarkerDefs, buildMarkerId } from '../SvgMarkerDefs';
import type { MarkerConfig } from '../SvgMarkerDefs';
import { RasterImageConfig } from '../widget-configs/RasterImageConfig';
import { DEFAULT_SVG_TRANSFORM, clampTransform } from '../../../types/scada-transform.types';
import type { SvgTransform } from '../../../types/scada-transform.types';

/* ------------------------------------------------------------------ */
/*  TransformConfig Tests                                              */
/* ------------------------------------------------------------------ */

describe('TransformConfig', () => {
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChange = vi.fn();
  });

  it('renders rotation input after expanding', () => {
    render(
      <TransformConfig
        transform={DEFAULT_SVG_TRANSFORM}
        onChange={onChange}
      />,
    );

    // Section starts collapsed -- expand it
    const toggle = screen.getByRole('button', { name: /transform settings/i });
    fireEvent.click(toggle);

    const rotationInput = screen.getByLabelText(/rotation degrees/i);
    expect(rotationInput).toBeDefined();
    expect((rotationInput as HTMLInputElement).value).toBe('0');
  });

  it('clamps values to safe bounds via clampTransform utility', () => {
    // Rotation wraps to [0, 360)
    const clamped1 = clampTransform({ rotation: 400 });
    expect(clamped1.rotation).toBe(40);

    // Negative rotation wraps correctly
    const clamped2 = clampTransform({ rotation: -30 });
    expect(clamped2.rotation).toBe(330);

    // Scale clamped to [0.1, 10]
    const clamped3 = clampTransform({ scaleX: 0, scaleY: 15 });
    expect(clamped3.scaleX).toBe(0.1);
    expect(clamped3.scaleY).toBe(10);

    // Skew clamped to [-89, 89]
    const clamped4 = clampTransform({ skewX: -100, skewY: 100 });
    expect(clamped4.skewX).toBe(-89);
    expect(clamped4.skewY).toBe(89);
  });

  it('origin grid has 9 clickable points', () => {
    render(
      <TransformConfig
        transform={DEFAULT_SVG_TRANSFORM}
        onChange={onChange}
      />,
    );

    // Expand the section
    fireEvent.click(screen.getByRole('button', { name: /transform settings/i }));

    // The radiogroup should have 9 items
    const radiogroup = screen.getByRole('radiogroup', { name: /transform origin/i });
    const buttons = within(radiogroup).getAllByRole('radio');
    expect(buttons.length).toBe(9);

    // Click top-left origin
    const topLeft = screen.getByTestId('origin-top-left');
    fireEvent.click(topLeft);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ originX: 0, originY: 0 }),
    );
  });

  it('reset button restores defaults', () => {
    const modified: SvgTransform = {
      rotation: 45,
      scaleX: 2,
      scaleY: 2,
      skewX: 10,
      skewY: -10,
      originX: 0,
      originY: 1,
    };

    render(
      <TransformConfig
        transform={modified}
        onChange={onChange}
      />,
    );

    // Expand
    fireEvent.click(screen.getByRole('button', { name: /transform settings/i }));

    // Click reset
    const resetBtn = screen.getByTestId('transform-reset-all');
    fireEvent.click(resetBtn);

    expect(onChange).toHaveBeenCalledWith(DEFAULT_SVG_TRANSFORM);
  });
});

/* ------------------------------------------------------------------ */
/*  StrokeConfig Tests                                                 */
/* ------------------------------------------------------------------ */

describe('StrokeConfig', () => {
  const defaultProps = {
    stroke: '#1d4ed8',
    strokeWidth: 2,
    strokeOpacity: 1,
    dashPattern: 'solid' as const,
    lineCap: 'butt' as const,
    lineJoin: 'miter' as const,
    onChange: vi.fn(),
  };

  it('renders all 5 dash pattern options', () => {
    render(<StrokeConfig {...defaultProps} />);

    const select = screen.getByLabelText(/dash pattern/i) as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll('option'));
    expect(options.length).toBe(5);

    const values = options.map((o) => o.value);
    expect(values).toEqual(['solid', 'dotted', 'dashed', 'dashDot', 'dashDotDot']);
  });

  it('renders line cap radio group with 3 options', () => {
    render(<StrokeConfig {...defaultProps} />);

    const radiogroup = screen.getByRole('radiogroup', { name: /line cap style/i });
    const radios = within(radiogroup).getAllByRole('radio');
    expect(radios.length).toBe(3);
  });

  it('renders line join radio group with 3 options', () => {
    render(<StrokeConfig {...defaultProps} />);

    const radiogroup = screen.getByRole('radiogroup', { name: /line join style/i });
    const radios = within(radiogroup).getAllByRole('radio');
    expect(radios.length).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/*  SvgMarkerDefs Tests                                                */
/* ------------------------------------------------------------------ */

describe('SvgMarkerDefs', () => {
  const arrowMarker: MarkerConfig = { shape: 'arrow', size: 6, fill: '#000000' };
  const circleMarker: MarkerConfig = { shape: 'circle', size: 8, fill: '#ff0000' };
  const diamondMarker: MarkerConfig = { shape: 'diamond', size: 6, fill: '#00ff00' };
  const squareMarker: MarkerConfig = { shape: 'square', size: 6, fill: '#0000ff' };

  it('renders arrow marker path', () => {
    const { container } = render(
      <SvgMarkerDefs screenId="screen-1" markers={[arrowMarker]} />,
    );

    const path = container.querySelector('marker path');
    expect(path).not.toBeNull();
    // Arrow shape uses the specific d attribute
    expect(path?.getAttribute('d')).toBe('M 0 0 L 10 5 L 0 10 z');
  });

  it('generates unique IDs per screen', () => {
    const id1 = buildMarkerId('screen-A', arrowMarker);
    const id2 = buildMarkerId('screen-B', arrowMarker);

    expect(id1).toContain('screen-A');
    expect(id2).toContain('screen-B');
    expect(id1).not.toBe(id2);
  });

  it('renders circle, diamond, and square marker shapes', () => {
    const { container } = render(
      <SvgMarkerDefs
        screenId="screen-1"
        markers={[circleMarker, diamondMarker, squareMarker]}
      />,
    );

    const markers = container.querySelectorAll('marker');
    expect(markers.length).toBe(3);

    // Circle marker should contain a <circle> element
    const circleEl = container.querySelector('marker circle');
    expect(circleEl).not.toBeNull();
    expect(circleEl?.getAttribute('cx')).toBe('5');
    expect(circleEl?.getAttribute('cy')).toBe('5');

    // Diamond marker should contain a <path> with the diamond d attribute
    const paths = container.querySelectorAll('marker path');
    const diamondPath = Array.from(paths).find(
      (p) => p.getAttribute('d') === 'M 5 0 L 10 5 L 5 10 L 0 5 z',
    );
    expect(diamondPath).not.toBeNull();

    // Square marker should contain a <rect> element
    const rectEl = container.querySelector('marker rect');
    expect(rectEl).not.toBeNull();
    expect(rectEl?.getAttribute('width')).toBe('8');
  });
});

/* ------------------------------------------------------------------ */
/*  RasterImageConfig Tests                                            */
/* ------------------------------------------------------------------ */

describe('RasterImageConfig', () => {
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChange = vi.fn();
  });

  it('rejects non-image files via MIME type validation', async () => {
    render(
      <RasterImageConfig
        config={{}}
        onChange={onChange}
        deviceId={null}
      />,
    );

    const fileInput = screen.getByTestId('image-file-input') as HTMLInputElement;

    // Create a fake text file (invalid MIME type)
    const textFile = new File(['hello world'], 'test.txt', { type: 'text/plain' });
    fireEvent.change(fileInput, { target: { files: [textFile] } });

    // Should show error, not call onChange
    const error = screen.getByTestId('image-error');
    expect(error.textContent).toContain('Invalid file type');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('warns on large file sizes (>100KB) but allows them', async () => {
    render(
      <RasterImageConfig
        config={{}}
        onChange={onChange}
        deviceId={null}
      />,
    );

    const fileInput = screen.getByTestId('image-file-input') as HTMLInputElement;

    // Create a fake large PNG (150KB) -- content doesn't matter for validation
    const largeContent = new Uint8Array(150 * 1024);
    const largeFile = new File([largeContent], 'large.png', { type: 'image/png' });

    // Mock FileReader to simulate successful read
    const originalFileReader = globalThis.FileReader;
    const mockOnLoad = vi.fn();
    const MockFileReader = vi.fn().mockImplementation(() => ({
      readAsDataURL: vi.fn().mockImplementation(function (this: { onload: ((ev: { target: { result: string } }) => void) | null }) {
        // Simulate async read completion
        if (this.onload) {
          this.onload({ target: { result: 'data:image/png;base64,fake' } });
        }
      }),
      onload: null as ((ev: { target: { result: string } }) => void) | null,
    }));
    globalThis.FileReader = MockFileReader as unknown as typeof FileReader;

    fireEvent.change(fileInput, { target: { files: [largeFile] } });

    // Should show warning (not error) about large file
    const warning = screen.getByTestId('image-warning');
    expect(warning.textContent).toContain('Large image');
    expect(warning.textContent).toContain('S3/MinIO');

    // Restore
    globalThis.FileReader = originalFileReader;
  });
});
