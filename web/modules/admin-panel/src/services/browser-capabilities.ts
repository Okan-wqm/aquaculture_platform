import {
  AdminHttpContractError,
  createAdminAttachmentFilename,
  decodeAdminAttachmentFilename,
  type AdminAttachmentFilename,
} from '@platform/admin-http-contracts';

declare const ADMIN_NAVIGATION_URL_BRAND: unique symbol;

/** A same-origin HTTP(S) URL admitted by the admin navigation boundary. */
export type AdminNavigationUrl = string & {
  readonly [ADMIN_NAVIGATION_URL_BRAND]: true;
};

function currentAdminOrigin(): string {
  return typeof window === 'undefined' ? 'http://admin-panel.local' : window.location.origin;
}

/** Decode an API-provided application URL without invoking a DOM capability. */
export function decodeAdminSameOriginUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
    throw new AdminHttpContractError(
      '$.url',
      'expected a non-empty application URL up to 2048 characters',
    );
  }
  const origin = currentAdminOrigin();
  let parsed: URL;
  try {
    parsed = new URL(value, origin);
  } catch {
    throw new AdminHttpContractError('$.url', 'application URL is malformed');
  }
  if (
    parsed.origin !== origin ||
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new AdminHttpContractError(
      '$.url',
      'application URL must use the current HTTP(S) origin without credentials',
    );
  }
  return parsed;
}

/**
 * Decode navigation input before it reaches a browser capability.
 *
 * Relative application paths and absolute URLs on the current origin are
 * admitted. Protocol-relative, credential-bearing, cross-origin, data,
 * javascript and blob URLs are rejected rather than interpreted by the DOM.
 */
export function decodeAdminNavigationUrl(value: unknown): AdminNavigationUrl {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
    throw new AdminHttpContractError(
      '$.navigation',
      'expected a non-empty navigation URL up to 2048 characters',
    );
  }
  if (!value.startsWith('/') || value.startsWith('//')) {
    throw new AdminHttpContractError(
      '$.navigation',
      'admin navigation accepts only same-origin absolute paths',
    );
  }

  const parsed = decodeAdminSameOriginUrl(value);
  return parsed.href as AdminNavigationUrl;
}

export function isAdminNavigationUrl(value: unknown): boolean {
  try {
    decodeAdminNavigationUrl(value);
    return true;
  } catch (error) {
    if (error instanceof AdminHttpContractError) return false;
    throw error;
  }
}

/** The only admin-panel authority allowed to open a new browsing context. */
export function openAdminNavigation(value: unknown): void {
  if (typeof window === 'undefined') {
    throw new AdminHttpContractError('$.navigation', 'browser navigation is unavailable');
  }
  const url = decodeAdminNavigationUrl(value);
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (opened !== null) opened.opener = null;
}

/** The only owner of a full admin application reload. */
export function reloadAdminApplication(): void {
  if (typeof window === 'undefined') {
    throw new AdminHttpContractError('$.navigation', 'browser navigation is unavailable');
  }
  window.location.reload();
}

/** Normalize a locally composed label into the platform attachment vocabulary. */
export function createAdminDownloadFilename(value: string): AdminAttachmentFilename {
  return createAdminAttachmentFilename(value);
}

export interface AdminOwnedBlobDownload {
  readonly blob: Blob;
  readonly filename: AdminAttachmentFilename;
}

/**
 * The only owner of temporary object URLs and synthetic download anchors.
 * The object URL never escapes this synchronous capability scope and every
 * successful allocation is revoked in `finally` even if DOM interaction fails.
 */
export function downloadAdminOwnedBlob(download: AdminOwnedBlobDownload): void {
  if (!(download.blob instanceof Blob)) {
    throw new AdminHttpContractError('$.download.blob', 'expected a browser Blob');
  }
  const filename = decodeAdminAttachmentFilename(download.filename);
  const objectUrl = URL.createObjectURL(download.blob);
  let anchor: HTMLAnchorElement | undefined;
  try {
    anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor?.remove();
    URL.revokeObjectURL(objectUrl);
  }
}
