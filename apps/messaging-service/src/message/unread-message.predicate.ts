/**
 * Canonical "unread message" predicate — the SINGLE source of truth for what
 * counts as an unread message for a channel member (ORPHAN-100).
 *
 * A message is unread for a member iff ALL of:
 *   - it is not soft-deleted (`isDeleted = false`);
 *   - it was NOT authored by that member (`senderId != <member>`) — a user's own
 *     message never counts against their own unread badge;
 *   - it is newer than the member's `lastReadAt`, OR the member has never read
 *     the channel (`lastReadAt IS NULL`).
 *
 * Three code paths produce unread counts and previously diverged: the Redis HASH
 * counter and the DB fallback (`getUnreadCountFromDb`) both excluded the sender,
 * but the live channel-list badge subquery (`get-channels.handler`) did NOT — a
 * user's own message inflated their own badge. Both SQL paths now build their
 * WHERE clause from this one function so they cannot drift apart again.
 *
 * Returns a raw SQL fragment (no surrounding parentheses). The membership/tenant
 * scoping (`tenantId`, `channelId`, `cm.leftAt IS NULL`) is the caller's concern;
 * this fragment is ONLY the per-message "is it unread for this member" test.
 */
export function unreadMessagePredicateSql(p: {
  /** messages-table alias, e.g. `'m'`. */
  readonly msg: string;
  /** SQL expression for the member's lastReadAt, e.g. `'cm."lastReadAt"'`. */
  readonly lastReadAt: string;
  /** bound query parameter name carrying the member's userId, e.g. `'userId'`. */
  readonly userIdParam: string;
}): string {
  return (
    `${p.msg}."isDeleted" = false ` +
    `AND ${p.msg}."senderId" != :${p.userIdParam} ` +
    `AND (${p.lastReadAt} IS NULL OR ${p.msg}."createdAt" > ${p.lastReadAt})`
  );
}
