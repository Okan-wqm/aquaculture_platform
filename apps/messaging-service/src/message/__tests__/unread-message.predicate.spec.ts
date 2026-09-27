import { unreadMessagePredicateSql } from '../unread-message.predicate';

describe('unreadMessagePredicateSql (ORPHAN-100 unread SSoT)', () => {
  it('excludes soft-deleted messages, the member-own messages, and read messages', () => {
    const sql = unreadMessagePredicateSql({
      msg: 'm',
      lastReadAt: 'cm."lastReadAt"',
      userIdParam: 'userId',
    });

    // not deleted
    expect(sql).toContain('m."isDeleted" = false');
    // NOT authored by the member — the bug ORPHAN-100 fixed
    expect(sql).toContain('m."senderId" != :userId');
    // newer than lastReadAt OR never read
    expect(sql).toContain('cm."lastReadAt" IS NULL OR m."createdAt" > cm."lastReadAt"');
  });

  it('threads the caller-supplied alias, lastReadAt expr, and param name verbatim', () => {
    const sql = unreadMessagePredicateSql({
      msg: 'msg',
      lastReadAt: `COALESCE(membership."lastReadAt", '1970-01-01')`,
      userIdParam: 'viewerId',
    });

    expect(sql).toContain('msg."senderId" != :viewerId');
    expect(sql).toContain(`COALESCE(membership."lastReadAt", '1970-01-01') IS NULL`);
    expect(sql).toContain(`msg."createdAt" > COALESCE(membership."lastReadAt", '1970-01-01')`);
  });

  // MSGFIX-FAZ3 3.4: batched unread counting (push badge fan-out) passes the
  // member identity as a JOINED COLUMN EXPRESSION instead of a bound param —
  // one query counts for many users. Same SSoT fragment, no drift possible.
  it('MSGFIX-FAZ3: accepts a userIdSql column expression for batched counting', () => {
    const sql = unreadMessagePredicateSql({
      msg: 'm',
      lastReadAt: 'cm."lastReadAt"',
      userIdSql: 'cm."userId"',
    });

    expect(sql).toContain('m."isDeleted" = false');
    expect(sql).toContain('m."senderId" != cm."userId"');
    expect(sql).toContain('cm."lastReadAt" IS NULL OR m."createdAt" > cm."lastReadAt"');
  });

  it('MSGFIX-FAZ3: rejects ambiguous member identity (both or neither shape)', () => {
    expect(() => unreadMessagePredicateSql({ msg: 'm', lastReadAt: 'cm."lastReadAt"' })).toThrow(
      /exactly one of userIdParam or userIdSql/,
    );
    expect(() =>
      unreadMessagePredicateSql({
        msg: 'm',
        lastReadAt: 'cm."lastReadAt"',
        userIdParam: 'userId',
        userIdSql: 'cm."userId"',
      }),
    ).toThrow(/exactly one of userIdParam or userIdSql/);
  });
});
