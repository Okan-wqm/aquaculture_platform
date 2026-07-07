import {
  applyPermissionOverrides,
  parsePermissionOverrides,
} from '../permission-overrides.util';

describe('permission-overrides.util (tenant-RBAC effective-permission SSoT)', () => {
  describe('parsePermissionOverrides', () => {
    it('returns empty sets for null / undefined / empty', () => {
      expect(parsePermissionOverrides(null)).toEqual({ grants: [], revokes: [] });
      expect(parsePermissionOverrides(undefined)).toEqual({ grants: [], revokes: [] });
      expect(parsePermissionOverrides('')).toEqual({ grants: [], revokes: [] });
    });

    it('parses an already-parsed jsonb object', () => {
      expect(
        parsePermissionOverrides({ grants: ['users:invite'], revokes: ['roles:delete'] }),
      ).toEqual({ grants: ['users:invite'], revokes: ['roles:delete'] });
    });

    it('parses a JSON string (jsonb read back as text)', () => {
      expect(
        parsePermissionOverrides('{"grants":["ai_settings:manage"],"revokes":[]}'),
      ).toEqual({ grants: ['ai_settings:manage'], revokes: [] });
    });

    it('fails closed on malformed JSON / wrong shapes (no throw)', () => {
      expect(parsePermissionOverrides('{not json')).toEqual({ grants: [], revokes: [] });
      expect(parsePermissionOverrides(42)).toEqual({ grants: [], revokes: [] });
      expect(parsePermissionOverrides({ grants: 'nope' })).toEqual({ grants: [], revokes: [] });
    });
  });

  describe('applyPermissionOverrides', () => {
    it('returns the role base set when there are no overrides', () => {
      expect(
        applyPermissionOverrides(['sites:view', 'feeding:record'], { grants: [], revokes: [] }),
      ).toEqual(['sites:view', 'feeding:record']);
    });

    it('removes revoked permissions from the role base', () => {
      expect(
        applyPermissionOverrides(['sites:view', 'sites:edit'], {
          grants: [],
          revokes: ['sites:edit'],
        }),
      ).toEqual(['sites:view']);
    });

    it('adds granted permissions not present in the role base', () => {
      const result = applyPermissionOverrides(['sites:view'], {
        grants: ['roles:view'],
        revokes: [],
      });
      expect(result).toContain('sites:view');
      expect(result).toContain('roles:view');
    });

    it('grant wins over revoke of the same permission (order is load-bearing)', () => {
      // revoke removes it, grant re-adds it → net granted
      expect(
        applyPermissionOverrides(['users:invite'], {
          grants: ['users:invite'],
          revokes: ['users:invite'],
        }),
      ).toEqual(['users:invite']);
    });

    it('de-duplicates', () => {
      expect(
        applyPermissionOverrides(['sites:view', 'sites:view'], {
          grants: ['sites:view'],
          revokes: [],
        }),
      ).toEqual(['sites:view']);
    });
  });
});
