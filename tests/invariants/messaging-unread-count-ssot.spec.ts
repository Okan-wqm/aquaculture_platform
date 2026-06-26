/**
 * Platform-wide invariant — ORPHAN-100:
 *
 * Every messaging unread-count query MUST derive its per-message "is unread"
 * predicate from the single canonical helper `unreadMessagePredicateSql`
 * (apps/messaging-service/src/message/unread-message.predicate.ts).
 *
 * # Why
 *
 * Three paths produce unread counts — the Redis HASH counter, the DB fallback
 * `getUnreadCountFromDb`, and the live channel-list badge subquery in
 * `get-channels.handler`. The first two excluded the member's own messages; the
 * badge subquery did NOT, so a user's own message inflated their own unread
 * badge. The fix routes BOTH SQL paths through one predicate function. This guard
 * fails if a consumer hand-rolls the unread SQL again (the exact drift that
 * caused the split-brain).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SVC = 'apps/messaging-service/src';

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('INVARIANT (ORPHAN-100): messaging unread count has one SQL source of truth', () => {
  it('the canonical predicate excludes the member-own messages and never-read case', () => {
    const helper = read(`${SVC}/message/unread-message.predicate.ts`);
    expect(helper).toMatch(/export function unreadMessagePredicateSql/);
    // The three load-bearing clauses of "unread".
    expect(helper).toContain('"isDeleted" = false');
    expect(helper).toContain('"senderId" != :');
    expect(helper).toMatch(/IS NULL OR .*"createdAt" >/);
  });

  it('both SQL count paths consume the canonical predicate (not hand-rolled SQL)', () => {
    for (const rel of [
      `${SVC}/channel/queries/get-channels.handler.ts`,
      `${SVC}/message/services/message.service.ts`,
    ]) {
      const src = read(rel);
      expect(src).toContain('unreadMessagePredicateSql');
      // No inline unread SQL: a `createdAt" > ...lastReadAt` comparison must only
      // come from the helper, never typed directly in a consumer.
      const inlineUnread = /"createdAt"\s*>\s*[^)]*[lL]astReadAt/.test(src);
      expect(inlineUnread).toBe(false);
    }
  });
});
