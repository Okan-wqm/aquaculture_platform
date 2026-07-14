/**
 * Incident-media allowlist — farm-local, deliberately NARROW.
 *
 * This is NOT the broad messaging attachment allowlist. Incident photos are
 * operator field captures (escape / welfare / lice), so only raster images are
 * accepted. SVG is intentionally excluded: an SVG can carry inline <script> and
 * would become a stored-XSS vector when a presigned GET renders it inline.
 *
 * The list is enforced twice — at request time (before signing a presigned PUT)
 * and again on finalize against the object's real Content-Type — because the
 * presigned PUT itself cannot bind Content-Type (see MinioClientService).
 *
 * @module FishHealth
 */

/** Allowed image MIME types for incident media (images only, no svg — XSS). */
export const INCIDENT_MEDIA_ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Hard upper bound on a single incident photo (10 MB). */
export const INCIDENT_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

/** Maximum number of photos attachable to one incident record. */
export const INCIDENT_MEDIA_MAX_KEYS = 10;

/**
 * Case-insensitive membership test against the allowlist. Uses `.some` (not
 * `.includes`) so the `as const` tuple's literal element type accepts a plain
 * string argument without a widening cast.
 */
export function isAllowedIncidentMediaMime(mime: string): boolean {
  const normalized = mime.toLowerCase();
  return INCIDENT_MEDIA_ALLOWED_MIME.some((allowed) => allowed === normalized);
}
