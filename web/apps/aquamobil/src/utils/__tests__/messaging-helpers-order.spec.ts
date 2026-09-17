/**
 * Message ordering regression (user-reported 2026-09-17: "new messages appear
 * at the TOP"). The subgraph returns pages newest-first and pages stack
 * newest-page-first; the view needs oldest-first with live messages at the
 * BOTTOM. These tests pin the two pure helpers that own that contract.
 */
import { describe, expect, it } from 'vitest';

import { flattenMessagePages, insertNewestFirst } from '../messaging-helpers';

function m(n: number, at: string): { id: string; createdAt: string } {
  return { id: `id-${n}`, createdAt: at };
}

describe('flattenMessagePages — oldest-first view contract', () => {
  it('reverses BOTH page order and per-page item order (single page)', () => {
    // Exactly what the subgraph returns: items newest-first.
    const pages = [{ items: [m(3, 'T03'), m(2, 'T02'), m(1, 'T01')] }];
    expect(flattenMessagePages(pages).map((x) => x.id)).toEqual(['id-1', 'id-2', 'id-3']);
  });

  it('keeps oldest-first across pages (older page fetched via cursor)', () => {
    const pages = [
      { items: [m(3, 'T03'), m(2, 'T02')] }, // newest page first
      { items: [m(1, 'T01')] }, // older page appended by fetchNextPage
    ];
    expect(flattenMessagePages(pages).map((x) => x.id)).toEqual(['id-1', 'id-2', 'id-3']);
  });

  it('returns [] for undefined/empty pages', () => {
    expect(flattenMessagePages(undefined)).toEqual([]);
    expect(flattenMessagePages([])).toEqual([]);
  });
});

describe('insertNewestFirst — NEWEST-FIRST cache storage contract', () => {
  it('a live message lands at the FRONT (newest slot), not the tail', () => {
    const items = [m(3, 'T03'), m(2, 'T02'), m(1, 'T01')];
    const next = insertNewestFirst(items, m(4, 'T04'));
    expect(next.map((x) => x.id)).toEqual(['id-4', 'id-3', 'id-2', 'id-1']);
  });

  it('a reconnect-sync message OLDER than the head lands at its slot', () => {
    const items = [m(3, 'T03'), m(1, 'T01')];
    const next = insertNewestFirst(items, m(2, 'T02'));
    expect(next.map((x) => x.id)).toEqual(['id-3', 'id-2', 'id-1']);
  });

  it('dedupes by id (socket echo / idempotent replay)', () => {
    const items = [m(3, 'T03'), m(2, 'T02')];
    const next = insertNewestFirst(items, { id: 'id-2', createdAt: 'T02-updated' });
    expect(next).toHaveLength(2);
    expect(next[1]!.createdAt).toBe('T02-updated');
  });
});
