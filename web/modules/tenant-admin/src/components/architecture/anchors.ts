/**
 * In-page anchors of the two reference documents. The documents cross-cite
 * their parts ("05.3", "K3") and the review's priorities and scenarios link to
 * them, so every anchor is derived here, once, from the content: the page
 * renders a part under `reviewAnchorId(anchor)` and a link targets the same
 * id. Ids are prefixed so a document anchor cannot collide with an id the
 * shell renders.
 */
import { REVIEW_SECTIONS } from './content/review/sections';
import type { ReviewAnchor } from './types';

/** DOM id of an architecture section, e.g. `arch-01`. */
export function architectureAnchorId(num: string): string {
  return `arch-${num}`;
}

/** The review's anchor for its findings on a v3 section, e.g. `r05`. */
export function reviewSectionAnchor(num: string): ReviewAnchor {
  return `r${num}`;
}

/** The review's closing parts, under the anchors the review itself uses. */
export const REVIEW_CROSS_ANCHOR: ReviewAnchor = 'rk';
export const REVIEW_PROPOSALS_ANCHOR: ReviewAnchor = 'ro';
export const REVIEW_SCENARIOS_ANCHOR: ReviewAnchor = 'rs';

/** DOM id of a review part; `top` is the opening "first these" list. */
export function reviewAnchorId(anchor: ReviewAnchor | 'top'): string {
  return `review-${anchor}`;
}

/** Every anchor the review page renders, in document order. */
export const REVIEW_RENDERED_ANCHORS: readonly ReviewAnchor[] = [
  ...REVIEW_SECTIONS.map((section) => reviewSectionAnchor(section.num)),
  REVIEW_CROSS_ANCHOR,
  REVIEW_PROPOSALS_ANCHOR,
  REVIEW_SCENARIOS_ANCHOR,
];
