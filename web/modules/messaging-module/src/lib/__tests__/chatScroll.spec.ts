/**
 * chatScroll specs — FAZ 3.3 DoD: the "only if at the bottom" auto-follow
 * rule and the top-edge older-page trigger.
 */
import { describe, expect, it } from 'vitest';

import {
  NEAR_BOTTOM_THRESHOLD_PX,
  TOP_FETCH_TRIGGER_PX,
  isAtTopEdge,
  isNearBottom,
  type ScrollBoxLike,
} from '../chatScroll';

function box(scrollTop: number, clientHeight: number, scrollHeight: number): ScrollBoxLike {
  return { scrollTop, clientHeight, scrollHeight };
}

describe('isNearBottom', () => {
  it('true when the bottom edge is within the threshold', () => {
    expect(isNearBottom(box(920, 80, 1000))).toBe(true); // exactly at bottom
    expect(isNearBottom(box(920 - NEAR_BOTTOM_THRESHOLD_PX, 80, 1000))).toBe(true);
    expect(isNearBottom(box(920 - NEAR_BOTTOM_THRESHOLD_PX - 1, 80, 1000))).toBe(false);
  });

  it('a not-yet-laid-out container (height 0) counts as at-bottom (first render scrolls)', () => {
    expect(isNearBottom(box(0, 0, 0))).toBe(true);
  });
});

describe('isAtTopEdge', () => {
  it('true within the trigger threshold of the top', () => {
    expect(isAtTopEdge(box(0, 600, 4000))).toBe(true);
    expect(isAtTopEdge(box(TOP_FETCH_TRIGGER_PX, 600, 4000))).toBe(true);
    expect(isAtTopEdge(box(TOP_FETCH_TRIGGER_PX + 1, 600, 4000))).toBe(false);
  });
});
