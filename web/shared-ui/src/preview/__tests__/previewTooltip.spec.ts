/**
 * The inline chip's tooltip rules, without a DOM (FE-MEDIUM-337).
 *
 * Triggers: hover, focus and a press each show the tooltip on their own, so
 * one ending never hides what another still holds; Escape dismisses it until
 * the reader hovers, focuses or presses again (WCAG 1.4.13 dismissible and
 * persistent). Placement: above and centred on the chip while that fits the
 * viewport, otherwise below and/or aligned to the chip's nearer edge, so the
 * console's top-edge header and the right-edge workspace menu never cut it.
 */
import { describe, expect, it } from 'vitest';

import { placePreviewTooltip } from '../previewTooltipPlacement';
import {
  CLOSED_PREVIEW_TOOLTIP,
  isPreviewTooltipOpen,
  nextPreviewTooltip,
  type PreviewTooltipEvent,
  type PreviewTooltipTriggers,
} from '../previewTooltipTriggers';

function after(...events: PreviewTooltipEvent[]): PreviewTooltipTriggers {
  return events.reduce(nextPreviewTooltip, CLOSED_PREVIEW_TOOLTIP);
}

describe('preview tooltip triggers', () => {
  it('starts closed', () => {
    expect(isPreviewTooltipOpen(CLOSED_PREVIEW_TOOLTIP)).toBe(false);
  });

  it('stays open after a click: hover and focus open it, the press pins it, nothing toggles it off', () => {
    expect(isPreviewTooltipOpen(after('pointer-enter', 'focus', 'press'))).toBe(true);
    expect(isPreviewTooltipOpen(after('pointer-enter', 'focus', 'press', 'press'))).toBe(true);
  });

  it('keeps a focused tooltip open when the pointer leaves', () => {
    expect(isPreviewTooltipOpen(after('focus', 'pointer-enter', 'pointer-leave'))).toBe(true);
  });

  it('keeps a hovered tooltip open when focus leaves', () => {
    expect(isPreviewTooltipOpen(after('pointer-enter', 'focus', 'blur'))).toBe(true);
  });

  it('closes when the last trigger ends', () => {
    expect(isPreviewTooltipOpen(after('pointer-enter', 'pointer-leave'))).toBe(false);
    expect(isPreviewTooltipOpen(after('focus', 'blur'))).toBe(false);
    // A pin ends with focus leaving or a press elsewhere.
    expect(isPreviewTooltipOpen(after('focus', 'press', 'blur'))).toBe(false);
    expect(isPreviewTooltipOpen(after('pointer-enter', 'press', 'press-outside'))).toBe(false);
  });

  it('keeps a pressed tooltip open after the pointer leaves (a tap leaves no hover behind)', () => {
    expect(isPreviewTooltipOpen(after('pointer-enter', 'press', 'pointer-leave'))).toBe(true);
  });

  it('dismisses on Escape whatever opened it, until a trigger starts again', () => {
    expect(isPreviewTooltipOpen(after('pointer-enter', 'dismiss'))).toBe(false);
    expect(isPreviewTooltipOpen(after('focus', 'press', 'dismiss'))).toBe(false);
    expect(
      isPreviewTooltipOpen(after('pointer-enter', 'dismiss', 'pointer-leave', 'pointer-enter')),
    ).toBe(true);
    expect(isPreviewTooltipOpen(after('pointer-enter', 'dismiss', 'focus'))).toBe(true);
    expect(isPreviewTooltipOpen(after('focus', 'dismiss', 'press'))).toBe(true);
  });

  it('clears the hover a touch screen leaves behind on a press elsewhere', () => {
    expect(after('pointer-enter', 'press-outside').hovered).toBe(false);
  });
});

describe('placePreviewTooltip', () => {
  const VIEWPORT = { width: 1280, height: 800 };
  const TOOLTIP = { width: 288, height: 96 };
  /** A 22 px chip whose top-left corner is at (left, top). */
  const chipAt = (left: number, top: number): DOMRectReadOnly => new DOMRect(left, top, 22, 22);

  it('sits above and centred when the chip has room on every side', () => {
    expect(placePreviewTooltip(chipAt(600, 400), TOOLTIP, VIEWPORT)).toEqual({
      side: 'top',
      align: 'center',
    });
  });

  it('drops below a chip near the viewport top (the sticky console header)', () => {
    expect(placePreviewTooltip(chipAt(600, 40), TOOLTIP, VIEWPORT).side).toBe('bottom');
  });

  it('takes the roomier side when neither fits', () => {
    const short = { width: 1280, height: 120 };
    expect(placePreviewTooltip(chipAt(600, 20), TOOLTIP, short).side).toBe('bottom');
    expect(placePreviewTooltip(chipAt(600, 70), TOOLTIP, short).side).toBe('top');
  });

  it('aligns to the chip’s right edge near the viewport’s right edge (the workspace menu at phone width)', () => {
    const phone = { width: 390, height: 844 };
    expect(placePreviewTooltip(chipAt(340, 300), TOOLTIP, phone).align).toBe('end');
  });

  it('aligns to the chip’s left edge near the viewport’s left edge', () => {
    expect(placePreviewTooltip(chipAt(12, 400), TOOLTIP, VIEWPORT).align).toBe('start');
  });
});
