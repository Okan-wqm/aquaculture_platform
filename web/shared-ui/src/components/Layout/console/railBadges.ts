/**
 * Rail badge counts (digest §9): a page shows the count of its badge source,
 * an area the sum over its pages. A page with no source, or whose source has
 * no count yet, counts 0 — and a 0 draws no badge.
 */
import type { RailArea, RailBadgeCounts, RailPage } from './railTypes';

export function pageBadge(page: RailPage, badgeCounts: RailBadgeCounts): number {
  if (page.badge === undefined) return 0;
  return badgeCounts[page.badge] ?? 0;
}

export function areaBadge(area: RailArea, badgeCounts: RailBadgeCounts): number {
  let sum = 0;
  for (const group of area.groups) {
    for (const page of group.pages) sum += pageBadge(page, badgeCounts);
  }
  return sum;
}
