/**
 * Canonical messaging media MIME allowlist — single source of truth.
 *
 * MSG-MEDIUM-057: before this file, the server (media.service.ts) and the
 * client (useMediaUpload.ts) each kept their OWN hand-maintained
 * `ALLOWED_MIME_TYPES` Set. The two lists had silently drifted: the client
 * accepted `image/svg+xml` (an XSS vector — see below) AND was MISSING
 * `application/zip`, `application/x-7z-compressed`, `application/msword`,
 * `application/vnd.ms-excel`, and the office-document MIMEs the server allowed.
 * Two hand-maintained lists cannot be kept in sync by discipline alone, so the
 * allowlist now lives ONCE here and is consumed by BOTH sides
 * (`new Set(MESSAGING_MEDIA_MIME_ALLOWLIST)`).
 *
 * This module is intentionally ZERO-dependency (a frozen plain string array and
 * a derived union — no NestJS, React, or event-contracts import). The
 * shared-contracts tsconfig is deliberately isolated (no cross-lib paths), so a
 * cross-lib import would not even compile. Keeping it dependency-free is what
 * lets it be path-aliased (NOT npm-installed) into the standalone aquamobil
 * Vite/Rollup bundle without dragging a transitive barrel into the leaf build.
 *
 * The richer SERVER list is adopted as canonical; the client picks up the
 * previously-missing archive/office MIMEs for free, and `image/svg+xml` stays
 * excluded on BOTH sides.
 */

/**
 * The canonical, frozen list of MIME types accepted for messaging media
 * uploads. The server (trust boundary) enforces it; the client uses the same
 * list for pre-flight UX validation. An invariant spec asserts the server Set,
 * the client Set, and this list are byte-identical and that `image/svg+xml` is
 * absent, so the security posture cannot regress via a future hand-edit.
 */
export const MESSAGING_MEDIA_MIME_ALLOWLIST = Object.freeze([
  // ── Images ──
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  // 'image/svg+xml' is intentionally excluded: SVG files contain executable XML
  // (<script> tags, event handlers) and browsers render them as active HTML when
  // served with Content-Type: image/svg+xml — a stored XSS vector for all channel
  // viewers. Do NOT add it to this list; the invariant spec asserts its absence.

  // ── Documents ──
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',

  // ── Archives ──
  'application/zip',
  'application/x-7z-compressed',

  // ── Audio (voice notes + general audio) ──
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
  'audio/x-m4a',

  // ── Video ──
  'video/mp4',
  'video/webm',

  // ── Text ──
  'text/plain',
  'text/csv',
] as const);

/**
 * Union of every allowed messaging media MIME, derived from the frozen list so
 * the type and the runtime value can never diverge.
 */
export type MessagingMediaMime = (typeof MESSAGING_MEDIA_MIME_ALLOWLIST)[number];
