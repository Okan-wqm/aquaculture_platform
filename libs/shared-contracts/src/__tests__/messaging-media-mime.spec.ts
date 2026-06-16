import {
  MESSAGING_MEDIA_MIME_ALLOWLIST,
} from '../enums/messaging-media-mime';

/**
 * MSG-MEDIUM-057 — SSoT-level invariants for the messaging media MIME allowlist.
 *
 * These pin the security-load-bearing properties of the single source of truth
 * that BOTH the server (media.service) and the client (useMediaUpload /
 * AttachmentPicker) consume. The server-Set-equals-SSoT and client-Set-equals-
 * SSoT byte-identity checks live in the messaging-service and aquamobil specs
 * respectively (those files can import the concrete Sets).
 */
describe('MESSAGING_MEDIA_MIME_ALLOWLIST (SSoT)', () => {
  it('is frozen so a future hand-edit cannot mutate it at runtime', () => {
    expect(Object.isFrozen(MESSAGING_MEDIA_MIME_ALLOWLIST)).toBe(true);
    // A mutation attempt on a frozen array throws in strict mode (ts-jest runs
    // ESM-strict). Reflect.set returns false on a frozen target without needing a
    // type cast, so we assert the write is rejected and the length is unchanged.
    const before = MESSAGING_MEDIA_MIME_ALLOWLIST.length;
    expect(Reflect.set(MESSAGING_MEDIA_MIME_ALLOWLIST, before, 'image/svg+xml')).toBe(false);
    expect(MESSAGING_MEDIA_MIME_ALLOWLIST.length).toBe(before);
    expect(MESSAGING_MEDIA_MIME_ALLOWLIST).not.toContain('image/svg+xml');
  });

  it('EXCLUDES image/svg+xml (stored-XSS vector) — the security pin', () => {
    expect(MESSAGING_MEDIA_MIME_ALLOWLIST).not.toContain('image/svg+xml');
  });

  it('contains no duplicate entries', () => {
    const unique = new Set(MESSAGING_MEDIA_MIME_ALLOWLIST);
    expect(unique.size).toBe(MESSAGING_MEDIA_MIME_ALLOWLIST.length);
  });

  it('adopts the richer server list — archives + office docs are present', () => {
    // These were the entries the OLD client list silently dropped (MSG-MEDIUM-057
    // drift). The SSoT canonicalizes them.
    for (const mime of [
      'application/zip',
      'application/x-7z-compressed',
      'application/msword',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]) {
      expect(MESSAGING_MEDIA_MIME_ALLOWLIST).toContain(mime);
    }
  });

  it('contains the core image MIMEs that finalization strips + thumbnails', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
      expect(MESSAGING_MEDIA_MIME_ALLOWLIST).toContain(mime);
    }
  });
});
