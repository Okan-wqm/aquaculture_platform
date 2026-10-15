/**
 * The shell's module-level backstop boundary — now a re-export of the
 * shared-ui guard family's single ErrorBoundary (SSOT: one implementation,
 * many mount points). The host keeps mounting it around each federated
 * remote (App.tsx) as the last line of defense; module-internal per-route
 * containment (guards/RouteWithBoundary) fires first.
 */
export { ErrorBoundary as default } from '@aquaculture/shared-ui';
export { ErrorBoundary } from '@aquaculture/shared-ui';
