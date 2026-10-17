/**
 * Inbox rules: the seat notice once one more invitation fills the plan,
 * privileged users without two-factor sign-in, maintenance in force now.
 */
import { describe, expect, it } from 'vitest';

import { maintenanceInForce, seatNotice, usersWithoutMfa } from '../inbox';

describe('inbox rules', () => {
  it('warns about seats when one more invitation fills the plan, not before', () => {
    expect(seatNotice({ maxUsers: 15, currentUsers: 11, pendingUsers: 3 })).toEqual({
      used: 11,
      max: 15,
      pending: 3,
    });
    expect(seatNotice({ maxUsers: 15, currentUsers: 10, pendingUsers: 3 })).toBeNull();
    expect(seatNotice({ maxUsers: 0, currentUsers: 10, pendingUsers: 3 })).toBeNull();
    expect(seatNotice(null)).toBeNull();
  });

  it('names active admins and managers without two-factor sign-in only', () => {
    expect(
      usersWithoutMfa([
        {
          id: '1',
          firstName: 'Ingrid',
          lastName: 'Nilsen',
          email: 'i@x',
          role: 'TENANT_ADMIN',
          isActive: true,
          mfaEnabled: false,
        },
        {
          id: '2',
          firstName: null,
          lastName: null,
          email: 'lars@x',
          role: 'MODULE_MANAGER',
          isActive: true,
          mfaEnabled: false,
        },
        {
          id: '3',
          firstName: 'On',
          lastName: 'Mfa',
          email: 'o@x',
          role: 'TENANT_ADMIN',
          isActive: true,
          mfaEnabled: true,
        },
        {
          id: '4',
          firstName: 'Plain',
          lastName: 'User',
          email: 'p@x',
          role: 'MODULE_USER',
          isActive: true,
          mfaEnabled: false,
        },
        {
          id: '5',
          firstName: 'Gone',
          lastName: 'Admin',
          email: 'g@x',
          role: 'TENANT_ADMIN',
          isActive: false,
          mfaEnabled: false,
        },
      ]),
    ).toEqual(['Ingrid Nilsen', 'lars@x']);
  });

  it('keeps the maintenance announcements published, active and not expired', () => {
    const now = new Date('2026-10-17T10:00:00Z');
    const base = { title: 't', createdAt: '2026-10-10T00:00:00Z' };
    expect(
      maintenanceInForce(
        [
          {
            ...base,
            id: 'live',
            isActive: true,
            publishAt: '2026-10-16T00:00:00Z',
            expiresAt: null,
          },
          {
            ...base,
            id: 'future',
            isActive: true,
            publishAt: '2026-10-18T00:00:00Z',
            expiresAt: null,
          },
          {
            ...base,
            id: 'expired',
            isActive: true,
            publishAt: null,
            expiresAt: '2026-10-17T09:00:00Z',
          },
          { ...base, id: 'off', isActive: false, publishAt: null, expiresAt: null },
        ],
        now,
      ).map((announcement) => announcement.id),
    ).toEqual(['live']);
  });
});
