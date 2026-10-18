/**
 * Recent activity's words: each audit code auth-service writes into a
 * tenant's log has a phrase, an unknown code has none (the panel shows it as
 * recorded); the actor is the tenant's user by name, else the recorded
 * e-mail, else nobody the tenant lists — never the raw id.
 */
import { describe, expect, it } from 'vitest';

import { actionKeyOf, actorOf, initialsOf, type ActivityUser } from '../activity';

const USERS: ReadonlyMap<string, ActivityUser> = new Map([
  ['u-1', { id: 'u-1', firstName: 'Ingrid', lastName: 'Nilsen', email: 'ingrid@x.io' }],
  ['u-2', { id: 'u-2', firstName: null, lastName: null, email: 'lars@x.io' }],
]);

describe('actionKeyOf', () => {
  it('phrases the codes auth-service writes, one phrase for both failed-login codes', () => {
    expect(actionKeyOf('LOGIN_SUCCESS')).toBe('dashboard.activity.action.LOGIN_SUCCESS');
    expect(actionKeyOf('USER_ROLE_CHANGED')).toBe('dashboard.activity.action.USER_ROLE_CHANGED');
    expect(actionKeyOf('LOGIN_FAILED_INVALID_PASSWORD')).toBe(
      'dashboard.activity.action.LOGIN_FAILED',
    );
  });

  it('has no phrase for a code it does not know, nor for an inherited property name', () => {
    expect(actionKeyOf('BACKUP_EXPORTED')).toBeNull();
    expect(actionKeyOf('toString')).toBeNull();
  });
});

describe('actorOf', () => {
  it('names a tenant user by name, else by e-mail', () => {
    expect(actorOf({ performedBy: 'u-1', performedByEmail: null }, USERS)).toBe('Ingrid Nilsen');
    expect(actorOf({ performedBy: 'u-2', performedByEmail: null }, USERS)).toBe('lars@x.io');
  });

  it('falls back to the recorded e-mail, and to nobody — never the id', () => {
    expect(actorOf({ performedBy: 'f0f0', performedByEmail: 'ops@platform.io' }, USERS)).toBe(
      'ops@platform.io',
    );
    expect(actorOf({ performedBy: 'f0f0', performedByEmail: null }, USERS)).toBeNull();
  });

  it('marks an actor with two initials', () => {
    expect(initialsOf('Ingrid Nilsen')).toBe('IN');
    expect(initialsOf('ayse.demir@x.io')).toBe('AD');
    expect(initialsOf('lars@x.io')).toBe('LA');
  });
});
