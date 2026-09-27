/**
 * Chat scroll rules (FAZ 3.3) — pure, jsdom-testable predicates.
 *
 * The room auto-scrolls to the newest message ONLY when the user is already
 * at (near) the bottom; otherwise the new message is surfaced through the
 * "new messages" pill instead of yanking the viewport. Older pages are
 * fetched when the user scrolls to the top edge, and a prepend restores the
 * offset by the height the prepended content added.
 */

/** "At the bottom" tolerance — pixels from the bottom edge still counted as bottom. */
export const NEAR_BOTTOM_THRESHOLD_PX = 80;

/** Scroll-top distance that triggers an older-page fetch. */
export const TOP_FETCH_TRIGGER_PX = 40;

/** Minimal scroll-container surface the predicates need (jsdom-friendly). */
export interface ScrollBoxLike {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/**
 * True when the box is scrolled to (within `threshold` px of) its bottom — the
 * auto-follow condition. A not-yet-laid-out box (scrollHeight 0) counts as
 * at-bottom so the FIRST render scrolls to the newest message.
 */
export function isNearBottom(box: ScrollBoxLike, threshold = NEAR_BOTTOM_THRESHOLD_PX): boolean {
  if (box.scrollHeight <= 0) return true;
  return box.scrollTop + box.clientHeight >= box.scrollHeight - threshold;
}

/** True when the box is at its top edge — the older-page fetch trigger. */
export function isAtTopEdge(box: ScrollBoxLike, threshold = TOP_FETCH_TRIGGER_PX): boolean {
  return box.scrollTop <= threshold;
}
