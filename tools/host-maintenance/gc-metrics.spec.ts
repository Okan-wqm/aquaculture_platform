#!/usr/bin/env node
/**
 * The textfile is what the alerts in 65-host-maintenance.yml read. Two of
 * its stamps only work if they survive from pass to pass: the last
 * completed pass (WorktreeGcStale) and the start of an unarmed streak
 * (WorktreeGcUnarmed).
 *
 * Run: npm run tools:test
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { renderTextfile, type PassMetrics } from './gc-metrics.ts';

const OUTCOMES = { removed: 0, would_remove: 0, remove_failed: 0, remove_refused: 0, attention: 0 };

function pass(exitCode: number, armed: boolean): PassMetrics {
  return { exitCode, armed, outcomes: OUTCOMES, bytesReclaimed: null };
}

function stamp(text: string, metric: string): number | null {
  const match = new RegExp(`^${metric} (\\d+)$`, 'm').exec(text);
  return match?.[1] ? Number(match[1]) : null;
}

void test('a failed pass keeps the previous success stamp; a completed one moves it', () => {
  const first = renderTextfile(pass(0, true), 1000, '');
  const failed = renderTextfile(pass(1, true), 2000, first);
  const partial = renderTextfile(pass(3, true), 3000, failed);

  assert.equal(stamp(first, 'aqua_worktree_gc_last_success_timestamp_seconds'), 1000);
  assert.equal(stamp(failed, 'aqua_worktree_gc_last_success_timestamp_seconds'), 1000);
  assert.equal(stamp(failed, 'aqua_worktree_gc_last_exit_code'), 1);
  assert.equal(stamp(partial, 'aqua_worktree_gc_last_success_timestamp_seconds'), 3000);
});

void test('the unarmed stamp marks the start of the streak and disappears once armed', () => {
  const a = renderTextfile(pass(0, false), 1000, '');
  const b = renderTextfile(pass(0, false), 5000, a);
  const armed = renderTextfile(pass(0, true), 9000, b);

  assert.equal(stamp(b, 'aqua_worktree_gc_unarmed_since_timestamp_seconds'), 1000);
  assert.equal(stamp(armed, 'aqua_worktree_gc_unarmed_since_timestamp_seconds'), null);
  assert.equal(stamp(armed, 'aqua_worktree_gc_armed'), 1);
});

void test('a pass that never completed has no success stamp to report', () => {
  const failed = renderTextfile(pass(1, false), 1000, '');
  assert.equal(stamp(failed, 'aqua_worktree_gc_last_success_timestamp_seconds'), null);
});
