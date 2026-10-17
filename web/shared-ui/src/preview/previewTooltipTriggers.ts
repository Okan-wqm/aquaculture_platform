/**
 * What holds the inline preview chip's tooltip open (FE-MEDIUM-337).
 *
 * WHY separate triggers: one `open` flag let each event overwrite the others.
 * A click arrives after the hover and focus it brings, so toggling the flag
 * hid the tooltip on every click and every tap; leaving with the pointer hid
 * it while the chip still had focus. Each trigger is tracked on its own and
 * the tooltip shows while any of them holds (WCAG 1.4.13 persistent).
 *
 * WHAT: hover, focus and a press each show it. A press pins it until focus
 * leaves the chip or the reader presses elsewhere — a tap leaves no lasting
 * hover or focus behind on every touch browser, so the pin is what keeps the
 * tapped tooltip readable. Escape dismisses it whatever opened it, until a
 * trigger starts again (WCAG 1.4.13 dismissible).
 */

export interface PreviewTooltipTriggers {
  readonly hovered: boolean;
  readonly focused: boolean;
  readonly pinned: boolean;
  readonly dismissed: boolean;
}

export type PreviewTooltipEvent =
  | 'pointer-enter'
  | 'pointer-leave'
  | 'focus'
  | 'blur'
  | 'press'
  | 'press-outside'
  | 'dismiss';

export const CLOSED_PREVIEW_TOOLTIP: PreviewTooltipTriggers = Object.freeze({
  hovered: false,
  focused: false,
  pinned: false,
  dismissed: false,
});

export function nextPreviewTooltip(
  state: PreviewTooltipTriggers,
  event: PreviewTooltipEvent,
): PreviewTooltipTriggers {
  switch (event) {
    case 'pointer-enter':
      return { ...state, hovered: true, dismissed: false };
    case 'pointer-leave':
      return { ...state, hovered: false };
    case 'focus':
      return { ...state, focused: true, dismissed: false };
    case 'blur':
      return { ...state, focused: false, pinned: false };
    case 'press':
      return { ...state, pinned: true, dismissed: false };
    case 'press-outside':
      // A touch screen keeps the tapped element "hovered" until another tap.
      return { ...state, hovered: false, pinned: false };
    case 'dismiss':
      return { ...state, pinned: false, dismissed: true };
  }
}

export function isPreviewTooltipOpen(state: PreviewTooltipTriggers): boolean {
  return (state.hovered || state.focused || state.pinned) && !state.dismissed;
}
