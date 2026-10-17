/**
 * Where the inline preview chip's tooltip opens (FE-MEDIUM-337).
 *
 * WHY: a tooltip pinned above and centred on its chip was cut off in both
 * places the chip sits today — the title block in the sticky console header,
 * about 40 px below the viewport's top edge, and the workspace menu's alarm
 * column at the viewport's right edge on a phone. The chip's host cannot know
 * where it lands at every width, so the tooltip measures and picks.
 *
 * WHAT: above the chip when it fits, else below, else whichever side has more
 * room; centred on the chip when it fits, else aligned to the chip's edge
 * nearer the overflowing viewport edge, so the tooltip grows inward.
 */

/** Kept clear between the tooltip and the viewport edge, in CSS px. */
const VIEWPORT_MARGIN = 8;

export interface PreviewTooltipPlacement {
  readonly side: 'top' | 'bottom';
  readonly align: 'start' | 'center' | 'end';
}

export const DEFAULT_PREVIEW_TOOLTIP_PLACEMENT: PreviewTooltipPlacement = Object.freeze({
  side: 'top',
  align: 'center',
});

type AnchorBox = Pick<DOMRectReadOnly, 'top' | 'bottom' | 'left' | 'right'>;
type TooltipBox = Pick<DOMRectReadOnly, 'width' | 'height'>;

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export function placePreviewTooltip(
  anchor: AnchorBox,
  tooltip: TooltipBox,
  viewport: ViewportSize,
): PreviewTooltipPlacement {
  const roomAbove = anchor.top - VIEWPORT_MARGIN;
  const roomBelow = viewport.height - anchor.bottom - VIEWPORT_MARGIN;
  const side = tooltip.height <= roomAbove || roomAbove >= roomBelow ? 'top' : 'bottom';

  const centre = (anchor.left + anchor.right) / 2;
  const half = tooltip.width / 2;
  const align =
    centre + half > viewport.width - VIEWPORT_MARGIN
      ? 'end'
      : centre - half < VIEWPORT_MARGIN
        ? 'start'
        : 'center';

  return { side, align };
}
