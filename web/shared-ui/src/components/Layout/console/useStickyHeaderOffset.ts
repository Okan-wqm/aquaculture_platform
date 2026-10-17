/**
 * useStickyHeaderOffset — how much of the viewport's top the console header
 * covers, published as `--sd-header-sticky-h` on <html>, which suderra.css
 * reads as the document's `scroll-padding-top` (WCAG 2.4.11).
 *
 * WHY: a sticky header sits over the page it scrolls. Without the padding a
 * control reached with Tab, or a fragment scrolled to, could stop under the
 * header — focused but hidden. With it the browser scrolls such a target to
 * just below the header.
 *
 * WHY measured and not a constant: the header's height follows its content
 * (a two-line title, the annunciator, the console width), and whether it
 * sticks at all follows the console width and the viewport height
 * (ConsoleHeader) — so the computed `position` decides, and a header that
 * scrolls with the page covers nothing (0). The header's own size changes
 * reach the ResizeObserver; a viewport-height change that only flips its
 * position reaches the window `resize` listener. The property is removed
 * when the header unmounts, so no other frame inherits a stale offset.
 */
import { useLayoutEffect, type RefObject } from 'react';

/** The custom property suderra.css turns into `scroll-padding-top` on <html>. */
export const STICKY_HEADER_HEIGHT = '--sd-header-sticky-h';

export function useStickyHeaderOffset(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const header = ref.current;
    if (header === null) return undefined;
    const root = document.documentElement;
    const publish = (): void => {
      const covers =
        getComputedStyle(header).position === 'sticky'
          ? Math.ceil(header.getBoundingClientRect().height)
          : 0;
      root.style.setProperty(STICKY_HEADER_HEIGHT, `${covers}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(header);
    window.addEventListener('resize', publish);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', publish);
      root.style.removeProperty(STICKY_HEADER_HEIGHT);
    };
  }, [ref]);
}
