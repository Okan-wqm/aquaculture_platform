import { isEffectiveUserSiteAssignmentAt } from './user-site-assignment-reader';

describe('isEffectiveUserSiteAssignmentAt', () => {
  const boundary = new Date('2026-08-01T12:00:00.000Z');

  it('uses one strict expiry boundary for reads and reactivation', () => {
    expect(
      isEffectiveUserSiteAssignmentAt(
        { isActive: true, expiresAt: new Date(boundary.getTime() + 1) },
        boundary,
      ),
    ).toBe(true);
    expect(isEffectiveUserSiteAssignmentAt({ isActive: true, expiresAt: boundary }, boundary)).toBe(
      false,
    );
    expect(isEffectiveUserSiteAssignmentAt({ isActive: false, expiresAt: null }, boundary)).toBe(
      false,
    );
  });

  it('treats only explicit null as permanent and fails closed on malformed dates', () => {
    expect(isEffectiveUserSiteAssignmentAt({ isActive: true, expiresAt: null }, boundary)).toBe(
      true,
    );
    expect(
      isEffectiveUserSiteAssignmentAt({ isActive: true, expiresAt: undefined }, boundary),
    ).toBe(false);
    expect(
      isEffectiveUserSiteAssignmentAt({ isActive: true, expiresAt: new Date('invalid') }, boundary),
    ).toBe(false);
    expect(
      isEffectiveUserSiteAssignmentAt(
        { isActive: true, expiresAt: new Date(boundary.getTime() + 1) },
        new Date('invalid'),
      ),
    ).toBe(false);
  });
});
