/**
 * Accessibility (a11y) Component Primitives
 *
 * Reusable components that make WCAG 2.1 AA compliance structural
 * rather than relying on individual aria-* attribute fixes.
 *
 * @see FE-HIGH-017, FE-HIGH-018, FE-HIGH-019
 */

export { VisuallyHidden } from './VisuallyHidden';
export type { VisuallyHiddenProps } from './VisuallyHidden';

export { FocusTrap } from './FocusTrap';
export type { FocusTrapProps } from './FocusTrap';

export { RouteAnnouncer } from './RouteAnnouncer';
export type { RouteAnnouncerProps } from './RouteAnnouncer';
