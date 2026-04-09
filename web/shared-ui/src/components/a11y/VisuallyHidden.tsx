/**
 * VisuallyHidden Component
 *
 * Renders content that is visually hidden but accessible to screen readers.
 * Uses the standard clip-rect pattern recommended by WCAG 2.1 AA.
 *
 * FE-HIGH-018: Provides a reusable primitive for adding screen-reader-only
 * text throughout the application, making ad-hoc aria-label hacks unnecessary.
 *
 * @see FE-HIGH-018
 *
 * @example
 * // Add context for screen readers without visual UI
 * <button>
 *   <TrashIcon />
 *   <VisuallyHidden>Delete farm "Deniz Cifligi"</VisuallyHidden>
 * </button>
 *
 * @example
 * // Announce dynamic content
 * <VisuallyHidden as="div" role="status" aria-live="polite">
 *   {`${results.length} results found`}
 * </VisuallyHidden>
 */

import React from 'react';

// ============================================================================
// Types
// ============================================================================

export interface VisuallyHiddenProps {
  /** Content to render (visible only to screen readers) */
  children: React.ReactNode;
  /** HTML element to render (default: 'span') */
  as?: keyof JSX.IntrinsicElements;
  /** Additional HTML attributes */
  [key: string]: unknown;
}

// ============================================================================
// Styles
// ============================================================================

/**
 * CSS properties for visually hidden content.
 * Uses the clip-rect pattern (not display:none or visibility:hidden,
 * which hide content from screen readers too).
 */
const visuallyHiddenStyle: React.CSSProperties = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

// ============================================================================
// Component
// ============================================================================

export const VisuallyHidden: React.FC<VisuallyHiddenProps> = ({
  children,
  as: Component = 'span',
  ...rest
}) => {
  return React.createElement(
    Component as string,
    { ...rest, style: visuallyHiddenStyle },
    children,
  );
};
