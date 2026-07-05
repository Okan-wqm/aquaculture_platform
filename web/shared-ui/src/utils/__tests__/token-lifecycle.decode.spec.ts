import { describe, it, expect } from 'vitest';
import { decodeResourcePermissions } from '../token-lifecycle';

/**
 * Faz 7 RBAC-FE: decodeResourcePermissions extracts the tenant-RBAC capability
 * claim from the access token for UI visibility. It must be strictly
 * fail-closed — any malformed / missing / wrong-typed claim yields [] so the
 * UI never shows an action off a garbage token (the backend enforces anyway).
 */
function makeToken(payload: Record<string, unknown>): string {
  const b64 = btoa(JSON.stringify(payload));
  return `header.${b64}.signature`;
}

describe('decodeResourcePermissions', () => {
  it('returns the resourcePermissions array from a valid token', () => {
    const token = makeToken({
      sub: 'u1',
      resourcePermissions: ['channels:create_group', 'ai_assistant:use'],
    });
    expect(decodeResourcePermissions(token)).toEqual([
      'channels:create_group',
      'ai_assistant:use',
    ]);
  });

  it('returns [] when the claim is absent (omitted for empty / admins)', () => {
    expect(decodeResourcePermissions(makeToken({ sub: 'u1' }))).toEqual([]);
  });

  it('returns [] for a non-array claim', () => {
    expect(
      decodeResourcePermissions(makeToken({ resourcePermissions: 'nope' })),
    ).toEqual([]);
  });

  it('returns [] when any entry is not a string (fail-closed, no partial trust)', () => {
    expect(
      decodeResourcePermissions(
        makeToken({ resourcePermissions: ['ok:action', 42] }),
      ),
    ).toEqual([]);
  });

  it('returns [] for a structurally invalid token', () => {
    expect(decodeResourcePermissions('not-a-jwt')).toEqual([]);
    expect(decodeResourcePermissions('')).toEqual([]);
    expect(decodeResourcePermissions('a.b')).toEqual([]);
  });

  it('returns [] for an undecodable payload', () => {
    expect(decodeResourcePermissions('header.@@@notbase64@@@.sig')).toEqual([]);
  });
});
