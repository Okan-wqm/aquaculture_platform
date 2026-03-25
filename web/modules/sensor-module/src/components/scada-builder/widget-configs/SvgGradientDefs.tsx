/**
 * Renders SVG <defs> containing gradient and filter definitions
 * for a single widget. Placed inside the widget's SVG render tree.
 *
 * Architecture: Each widget that uses gradients/filters renders its
 * own defs block. Widget-scoped IDs prevent cross-widget collisions
 * when multiple widgets on the same SCADA screen use gradients.
 *
 * When gradient type is 'none', no gradient definition is rendered.
 * When filter type is 'none', no filter definition is rendered.
 * If both are 'none', the component returns null (no <defs> at all).
 *
 * SVG filters use primitive elements (<feGaussianBlur>, <feOffset>,
 * <feFlood>, <feComposite>, <feMerge>) rather than the shorthand
 * <feDropShadow> for maximum cross-browser compatibility.
 */

import React, { memo } from 'react';
import type { GradientConfig, SvgFilterConfig } from '../../../types/scada-svg-properties.types';
import {
  buildGradientId,
  buildFilterId,
  angleToGradientCoords,
} from '../../../types/scada-svg-properties.types';

/* ------------------------------------------------------------------ */
/*  Props                                                               */
/* ------------------------------------------------------------------ */

interface SvgGradientDefsProps {
  widgetId: string;
  /** Fill gradient config -- undefined or type 'none' means no gradient */
  fillGradient?: GradientConfig;
  /** Stroke gradient config -- reserved for future use */
  strokeGradient?: GradientConfig;
  /** Filter effect config -- undefined or type 'none' means no filter */
  filter?: SvgFilterConfig;
}

/* ------------------------------------------------------------------ */
/*  Gradient <defs> builder                                             */
/* ------------------------------------------------------------------ */

/**
 * Renders a single gradient definition element (linear or radial).
 * Returns null when gradient type is 'none' or stops are insufficient.
 */
const GradientDef: React.FC<{
  gradient: GradientConfig;
  id: string;
}> = ({ gradient, id }) => {
  if (gradient.type === 'none' || gradient.stops.length < 2) return null;

  const stops = gradient.stops.map((stop, i) => (
    <stop
      key={i}
      offset={`${stop.offset * 100}%`}
      stopColor={stop.color}
      stopOpacity={stop.opacity}
    />
  ));

  if (gradient.type === 'linear') {
    const coords = angleToGradientCoords(gradient.angle);
    return (
      <linearGradient
        id={id}
        x1={coords.x1}
        y1={coords.y1}
        x2={coords.x2}
        y2={coords.y2}
      >
        {stops}
      </linearGradient>
    );
  }

  // Radial gradient: centered at 50%/50%, radius 50%
  return (
    <radialGradient id={id} cx="50%" cy="50%" r="50%">
      {stops}
    </radialGradient>
  );
};

/* ------------------------------------------------------------------ */
/*  Filter <defs> builder                                               */
/* ------------------------------------------------------------------ */

/**
 * Renders SVG filter primitives for the specified filter type.
 * Uses composable SVG filter primitives for cross-browser SVG compat.
 *
 * Filter region is expanded (x/y -50%, width/height 200%) to ensure
 * effects like glow and shadow are not clipped at widget boundaries.
 */
const FilterDef: React.FC<{
  filter: SvgFilterConfig;
  id: string;
}> = ({ filter, id }) => {
  if (filter.type === 'none') return null;

  if (filter.type === 'blur') {
    return (
      <filter id={id} x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur
          in="SourceGraphic"
          stdDeviation={filter.blurRadius ?? 4}
        />
      </filter>
    );
  }

  if (filter.type === 'dropShadow') {
    const dx = filter.shadowX ?? 2;
    const dy = filter.shadowY ?? 2;
    const blur = filter.blurRadius ?? 4;
    const color = filter.shadowColor ?? '#000000';
    const opacity = filter.shadowOpacity ?? 0.5;

    return (
      <filter id={id} x="-50%" y="-50%" width="200%" height="200%">
        {/* Create the shadow layer */}
        <feFlood floodColor={color} floodOpacity={opacity} result="shadowColor" />
        <feComposite in="shadowColor" in2="SourceAlpha" operator="in" result="shadow" />
        <feGaussianBlur in="shadow" stdDeviation={blur} result="blurredShadow" />
        <feOffset in="blurredShadow" dx={dx} dy={dy} result="offsetShadow" />
        {/* Merge shadow behind the original graphic */}
        <feMerge>
          <feMergeNode in="offsetShadow" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    );
  }

  // Glow: centered (no offset) blur in the glow color
  if (filter.type === 'glow') {
    const blur = filter.blurRadius ?? 6;
    const color = filter.shadowColor ?? '#3b82f6';
    const opacity = filter.shadowOpacity ?? 0.8;

    return (
      <filter id={id} x="-50%" y="-50%" width="200%" height="200%">
        <feFlood floodColor={color} floodOpacity={opacity} result="glowColor" />
        <feComposite in="glowColor" in2="SourceAlpha" operator="in" result="glow" />
        <feGaussianBlur in="glow" stdDeviation={blur} result="blurredGlow" />
        {/* Merge glow behind original */}
        <feMerge>
          <feMergeNode in="blurredGlow" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    );
  }

  return null;
};

/* ------------------------------------------------------------------ */
/*  SvgGradientDefs                                                     */
/* ------------------------------------------------------------------ */

const SvgGradientDefs: React.FC<SvgGradientDefsProps> = ({
  widgetId,
  fillGradient,
  strokeGradient,
  filter,
}) => {
  const hasFillGradient = fillGradient && fillGradient.type !== 'none';
  const hasStrokeGradient = strokeGradient && strokeGradient.type !== 'none';
  const hasFilter = filter && filter.type !== 'none';

  // Avoid rendering empty <defs> -- SVG spec allows it but it's wasteful
  if (!hasFillGradient && !hasStrokeGradient && !hasFilter) return null;

  return (
    <defs>
      {hasFillGradient && (
        <GradientDef
          gradient={fillGradient}
          id={buildGradientId(widgetId, 'fill')}
        />
      )}
      {hasStrokeGradient && (
        <GradientDef
          gradient={strokeGradient}
          id={buildGradientId(widgetId, 'stroke')}
        />
      )}
      {hasFilter && (
        <FilterDef
          filter={filter}
          id={buildFilterId(widgetId)}
        />
      )}
    </defs>
  );
};

SvgGradientDefs.displayName = 'SvgGradientDefs';
export default memo(SvgGradientDefs);
