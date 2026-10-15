/**
 * RouteWithBoundary — the guard family's per-route containment wrapper.
 *
 * Wraps a route's `element` in the family ErrorBoundary so a crash on ONE
 * route is contained to that route's viewport (nav and sibling routes keep
 * working) instead of unwinding to the module-level backstop or the host.
 * It deliberately introduces NO new boundary class — it composes the
 * family's single ErrorBoundary (SSOT: one boundary implementation, many
 * mount points).
 */
import React from 'react';
import { ErrorBoundary } from './ErrorBoundary';
import type { ErrorBoundaryProps } from './ErrorBoundary';

export interface RouteWithBoundaryProps extends Omit<ErrorBoundaryProps, 'children'> {
  /** The route element to contain (preferred form: this prop). */
  element?: React.ReactNode;
  /** Alternative child form — equivalent to . */
  children?: React.ReactNode;
}

export const RouteWithBoundary: React.FC<RouteWithBoundaryProps> = ({
  element,
  children,
  ...boundaryProps
}) => <ErrorBoundary {...boundaryProps}>{element ?? children}</ErrorBoundary>;
