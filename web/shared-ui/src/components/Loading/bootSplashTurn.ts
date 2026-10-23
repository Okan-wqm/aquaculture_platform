/**
 * The boot splash's turn, carried into React (FE-MEDIUM-349).
 *
 * WHAT: the moment the boot splash's mark started turning, read from the
 * document timeline just before React replaces the splash (the shell calls
 * holdBootSplashTurn right before its first render), and handed to every
 * BrandLoader that mounts after it (useBootSplashTurn).
 *
 * WHY: React's first render swaps the splash's DOM for the BrandLoader's. A
 * CSS animation starts over on a new element, so the mark would snap back to
 * its first angle at the hand-off — the one visible change left once the two
 * share their markup and stylesheet. Started at the splash's start time, the
 * new mark stands at the angle the old one had reached, and the turn carries
 * on. Web Animations is in every browser the console supports; jsdom has
 * none, so where the element offers no timeline the CSS animation is left as
 * it is.
 */
import { useLayoutEffect, type RefObject } from 'react';

const MARK = '.brand-loader__mark';

let splashTurnStart: CSSNumberish | null = null;

function turnsOf(element: Element): Animation[] {
  return 'getAnimations' in element ? element.getAnimations() : [];
}

/** Remembers when the boot splash's mark started turning; none held when there is no splash. */
export function holdBootSplashTurn(root: ParentNode = document): void {
  const mark = root.querySelector(MARK);
  splashTurnStart = mark === null ? null : (turnsOf(mark)[0]?.startTime ?? null);
}

/** Starts a BrandLoader mark's turn where the boot splash's had reached. */
export function useBootSplashTurn(mark: RefObject<Element | null>): void {
  useLayoutEffect(() => {
    const element = mark.current;
    if (element === null || splashTurnStart === null) return;
    for (const turn of turnsOf(element)) turn.startTime = splashTurnStart;
  }, [mark]);
}
