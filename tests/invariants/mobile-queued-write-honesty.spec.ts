/**
 * A queued write is not a recorded write, and the screen must say so.
 *
 * AquaMobil's record pages accept a write while offline by putting it in the
 * device queue. The queue is not the database: the server can still reject the
 * operation when it finally syncs. A page that answers `addToQueue` with a
 * green tick tells the operator the fish were logged, the transfer happened,
 * the stock moved — for a write the server has never seen, and may refuse.
 *
 * The platform's answer is `QueuedStatusBadge`, which reports the operation's
 * REAL state (pending / syncing / synced / failed) from the id `addToQueue`
 * returns. Eight of the nine queueing pages already use it; this gate keeps
 * the ninth from being written.
 *
 * The rule is derived from the code, not listed: a page that calls
 * `addToQueue(` must render the badge, unless it is an allowlisted page that
 * reports queued state some other honest way.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const PAGES_DIR = resolve(REPO_ROOT, 'web/apps/aquamobil/src/pages');

/**
 * Pages that queue writes and report queued state WITHOUT the shared badge,
 * each with the reason it is honest anyway. An entry here is a claim that the
 * page shows the operator the operation's real state some other way.
 */
const HONEST_WITHOUT_BADGE: ReadonlyMap<string, string> = new Map([
  [
    'messaging/ChatRoomPage.tsx',
    'Chat renders per-message state instead: optimistic sends carry `_status` ' +
      "'pending' / 'failed' on the bubble itself, which is the chat-native form of " +
      'the same honesty and is finer-grained than one badge per screen.',
  ],
]);

function collectPages(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      collectPages(full, out);
      continue;
    }
    if (entry.endsWith('.tsx') && !entry.endsWith('.spec.tsx')) out.push(full);
  }
}

describe('AquaMobil queued writes report their real state', () => {
  const pages: string[] = [];
  collectPages(PAGES_DIR, pages);

  it('finds the page tree', () => {
    expect(pages.length).toBeGreaterThan(10);
  });

  it('every page that queues a write renders QueuedStatusBadge', () => {
    const offenders: string[] = [];
    for (const page of pages) {
      const source = readFileSync(page, 'utf8');
      if (!source.includes('addToQueue(')) continue;
      const rel = relative(PAGES_DIR, page);
      if (HONEST_WITHOUT_BADGE.has(rel)) continue;
      if (source.includes('QueuedStatusBadge')) continue;
      offenders.push(
        `  ${relative(REPO_ROOT, page)} calls addToQueue() but never renders ` +
          'QueuedStatusBadge, so a queued write is indistinguishable from a recorded one. ' +
          'Keep the operation id addToQueue returns and render the badge, or add the page to ' +
          'HONEST_WITHOUT_BADGE with the way it reports queued state instead.',
      );
    }
    if (offenders.length > 0) {
      throw new Error(`Queued writes must not look recorded:\n${offenders.join('\n')}`);
    }
  });

  it('every allowlisted page still exists and still queues', () => {
    // An allowlist entry that no longer applies is a hole, so it expires by
    // construction rather than by anyone remembering to prune it.
    for (const [rel, reason] of HONEST_WITHOUT_BADGE) {
      const full = join(PAGES_DIR, rel);
      const source = readFileSync(full, 'utf8');
      expect(source).toContain('addToQueue(');
      expect(reason.length).toBeGreaterThan(60);
    }
  });
});
