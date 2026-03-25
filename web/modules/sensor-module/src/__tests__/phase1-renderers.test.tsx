/**
 * Phase 1B renderer tests -- SvgEllipseRenderer, SvgPathRenderer, RasterImageRenderer.
 *
 * Uses vitest + @testing-library/react to verify SVG attributes, placeholder
 * behaviour, and image rendering with lazy/async loading attributes.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import type { WidgetRendererProps } from '../components/scada-builder/WidgetRenderer';

/* ------------------------------------------------------------------ */
/*  Lazy-loaded components under test                                  */
/* ------------------------------------------------------------------ */

// Direct imports (not lazy) for unit testing — lazy loading is tested
// at the integration level via WidgetRenderer.
import SvgEllipseRenderer from '../components/scada-builder/widget-renderers/SvgEllipseRenderer';
import SvgPathRenderer from '../components/scada-builder/widget-renderers/SvgPathRenderer';
import RasterImageRenderer from '../components/scada-builder/widget-renderers/RasterImageRenderer';

afterEach(cleanup);

/* ------------------------------------------------------------------ */
/*  Helper: build default props for renderers                          */
/* ------------------------------------------------------------------ */

function makeProps(overrides: Partial<WidgetRendererProps> = {}): WidgetRendererProps {
  return {
    config: {},
    width: 200,
    height: 150,
    isEditing: false,
    ...overrides,
  };
}

/* ================================================================== */
/*  SvgEllipseRenderer                                                */
/* ================================================================== */

describe('SvgEllipseRenderer', () => {
  it('renders an ellipse with correct rx/ry derived from dimensions', () => {
    const { container } = render(
      <SvgEllipseRenderer {...makeProps({ config: { strokeWidth: 4 } })} />,
    );
    const ellipse = container.querySelector('ellipse');
    expect(ellipse).toBeTruthy();
    // rx = (200 - 4) / 2 = 98, ry = (150 - 4) / 2 = 73
    expect(ellipse?.getAttribute('rx')).toBe('98');
    expect(ellipse?.getAttribute('ry')).toBe('73');
    expect(ellipse?.getAttribute('cx')).toBe('100');
    expect(ellipse?.getAttribute('cy')).toBe('75');
  });

  it('applies fill and stroke from config', () => {
    const { container } = render(
      <SvgEllipseRenderer
        {...makeProps({ config: { fill: '#ff0000', stroke: '#00ff00' } })}
      />,
    );
    const ellipse = container.querySelector('ellipse');
    expect(ellipse?.getAttribute('fill')).toBe('#ff0000');
    expect(ellipse?.getAttribute('stroke')).toBe('#00ff00');
  });

  it('applies dash pattern via strokeDasharray', () => {
    const { container } = render(
      <SvgEllipseRenderer
        {...makeProps({ config: { dashPattern: 'dashed' } })}
      />,
    );
    const ellipse = container.querySelector('ellipse');
    // 'dashed' maps to '8 4' in DASH_PATTERN_MAP
    expect(ellipse?.getAttribute('stroke-dasharray')).toBe('8 4');
  });

  it('renders centered label text when label is provided', () => {
    const { container } = render(
      <SvgEllipseRenderer
        {...makeProps({ config: { label: 'Tank A' } })}
      />,
    );
    const text = container.querySelector('text');
    expect(text).toBeTruthy();
    expect(text?.textContent).toBe('Tank A');
    expect(text?.getAttribute('text-anchor')).toBe('middle');
    expect(text?.getAttribute('dominant-baseline')).toBe('central');
  });

  it('does not render label when label is empty', () => {
    const { container } = render(
      <SvgEllipseRenderer {...makeProps({ config: {} })} />,
    );
    const text = container.querySelector('text');
    expect(text).toBeFalsy();
  });

  it('applies fillOpacity and strokeOpacity separately', () => {
    const { container } = render(
      <SvgEllipseRenderer
        {...makeProps({ config: { fillOpacity: 0.5, strokeOpacity: 0.8 } })}
      />,
    );
    const ellipse = container.querySelector('ellipse');
    expect(ellipse?.getAttribute('fill-opacity')).toBe('0.5');
    expect(ellipse?.getAttribute('stroke-opacity')).toBe('0.8');
  });
});

/* ================================================================== */
/*  SvgPathRenderer                                                   */
/* ================================================================== */

describe('SvgPathRenderer', () => {
  it('renders a path with the correct d attribute from line points', () => {
    const points = [
      { x: 10, y: 10, type: 'line' as const },
      { x: 100, y: 50, type: 'line' as const },
      { x: 50, y: 100, type: 'line' as const },
    ];
    const { container } = render(
      <SvgPathRenderer
        {...makeProps({ config: { points, closed: false } })}
      />,
    );
    const path = container.querySelector('path');
    expect(path).toBeTruthy();
    const d = path?.getAttribute('d') ?? '';
    // First point is always M, subsequent are L
    expect(d).toContain('M 10 10');
    expect(d).toContain('L 100 50');
    expect(d).toContain('L 50 100');
  });

  it('shows placeholder with "Draw path" text when no points in edit mode', () => {
    const { container } = render(
      <SvgPathRenderer
        {...makeProps({ config: { points: [] }, isEditing: true })}
      />,
    );
    const text = container.querySelector('text');
    expect(text?.textContent).toBe('Draw path');
    // Placeholder uses dashed rect
    const rect = container.querySelector('rect');
    expect(rect?.getAttribute('stroke-dasharray')).toBe('6 4');
  });

  it('shows nothing when no points in runtime mode', () => {
    const { container } = render(
      <SvgPathRenderer
        {...makeProps({ config: { points: [] }, isEditing: false })}
      />,
    );
    // Should render empty div, no SVG
    expect(container.querySelector('svg')).toBeFalsy();
    expect(container.querySelector('text')).toBeFalsy();
  });

  it('appends Z command for closed paths', () => {
    const points = [
      { x: 0, y: 0, type: 'line' as const },
      { x: 100, y: 0, type: 'line' as const },
      { x: 100, y: 100, type: 'line' as const },
    ];
    const { container } = render(
      <SvgPathRenderer
        {...makeProps({ config: { points, closed: true } })}
      />,
    );
    const path = container.querySelector('path');
    const d = path?.getAttribute('d') ?? '';
    expect(d).toMatch(/Z$/);
  });

  it('renders quadratic bezier segments', () => {
    const points = [
      { x: 10, y: 10, type: 'quadratic' as const, cp1: { x: 20, y: -10 } },
      { x: 100, y: 50, type: 'line' as const },
    ];
    const { container } = render(
      <SvgPathRenderer
        {...makeProps({ config: { points, closed: false } })}
      />,
    );
    const path = container.querySelector('path');
    const d = path?.getAttribute('d') ?? '';
    // quadratic: Q cp.x cp.y next.x next.y
    // cp1 is relative: curr.x + cp1.x = 10+20=30, curr.y + cp1.y = 10+(-10)=0
    expect(d).toContain('Q 30 0 100 50');
  });
});

/* ================================================================== */
/*  RasterImageRenderer                                               */
/* ================================================================== */

describe('RasterImageRenderer', () => {
  it('renders img tag with correct src from config.imageData', () => {
    const src = 'https://example.com/photo.png';
    const { container } = render(
      <RasterImageRenderer
        {...makeProps({ config: { imageData: src } })}
      />,
    );
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe(src);
  });

  it('applies objectFit via CSS style', () => {
    const { container } = render(
      <RasterImageRenderer
        {...makeProps({ config: { imageData: 'https://example.com/a.jpg', objectFit: 'cover' } })}
      />,
    );
    const img = container.querySelector('img');
    expect(img?.style.objectFit).toBe('cover');
  });

  it('shows placeholder when no imageData in edit mode', () => {
    const { container } = render(
      <RasterImageRenderer
        {...makeProps({ config: {}, isEditing: true })}
      />,
    );
    // Placeholder has "Upload image" text
    expect(container.textContent).toContain('Upload image');
    // No img tag
    expect(container.querySelector('img')).toBeFalsy();
  });

  it('renders nothing visible when no imageData in runtime mode', () => {
    const { container } = render(
      <RasterImageRenderer
        {...makeProps({ config: {}, isEditing: false })}
      />,
    );
    expect(container.querySelector('img')).toBeFalsy();
    expect(container.textContent).toBe('');
  });

  it('has loading=lazy and decoding=async attributes', () => {
    const { container } = render(
      <RasterImageRenderer
        {...makeProps({ config: { imageData: 'https://example.com/b.webp' } })}
      />,
    );
    const img = container.querySelector('img');
    expect(img?.getAttribute('loading')).toBe('lazy');
    expect(img?.getAttribute('decoding')).toBe('async');
  });

  it('applies borderRadius and opacity via style', () => {
    const { container } = render(
      <RasterImageRenderer
        {...makeProps({
          config: { imageData: 'https://example.com/c.png', borderRadius: 12, opacity: 0.7 },
        })}
      />,
    );
    const img = container.querySelector('img');
    expect(img?.style.borderRadius).toBe('12px');
    expect(img?.style.opacity).toBe('0.7');
  });

  it('rejects invalid URL protocols', () => {
    const { container } = render(
      <RasterImageRenderer
        {...makeProps({ config: { imageData: 'javascript:alert(1)' }, isEditing: true })}
      />,
    );
    // Should show placeholder, not an img
    expect(container.querySelector('img')).toBeFalsy();
    expect(container.textContent).toContain('Upload image');
  });
});
