/**
 * usePreviewTooltip — the inline preview chip's tooltip behaviour
 * (FE-MEDIUM-337; WCAG 1.4.13).
 *
 * WHAT: the trigger state (previewTooltipTriggers.ts) wired to the chip's
 * events, the document-level dismissal, and the placement measured on open
 * (previewTooltipPlacement.ts).
 *
 * WHY document listeners: a tooltip opened by hover has no focus to receive
 * Escape, and a tap on Safari never focuses the button, so Escape and a press
 * elsewhere are heard on the document while the tooltip shows. Escape on the
 * chip itself stops there: it closes the tooltip, and only the next Escape
 * reaches the dialog around the chip (the workspace menu).
 */
import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';

import {
  DEFAULT_PREVIEW_TOOLTIP_PLACEMENT,
  placePreviewTooltip,
  type PreviewTooltipPlacement,
} from './previewTooltipPlacement';
import {
  CLOSED_PREVIEW_TOOLTIP,
  isPreviewTooltipOpen,
  nextPreviewTooltip,
} from './previewTooltipTriggers';

export interface PreviewTooltip {
  readonly open: boolean;
  readonly placement: PreviewTooltipPlacement;
  /** The positioned box around the chip and its tooltip: the hover area and the anchor. */
  readonly rootRef: RefObject<HTMLSpanElement | null>;
  readonly tooltipRef: RefObject<HTMLSpanElement | null>;
  readonly rootProps: {
    readonly onMouseEnter: () => void;
    readonly onMouseLeave: () => void;
  };
  readonly triggerProps: {
    readonly onFocus: () => void;
    readonly onBlur: () => void;
    readonly onClick: () => void;
    readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  };
}

export function usePreviewTooltip(): PreviewTooltip {
  const [triggers, dispatch] = useReducer(nextPreviewTooltip, CLOSED_PREVIEW_TOOLTIP);
  const [placement, setPlacement] = useState(DEFAULT_PREVIEW_TOOLTIP_PLACEMENT);
  const rootRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const open = isPreviewTooltipOpen(triggers);

  useEffect(() => {
    const root = rootRef.current;
    if (!open || root === null) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') dispatch('dismiss');
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && root.contains(event.target)) return;
      dispatch('press-outside');
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  // Measured before paint: the tooltip is laid out (no longer `hidden`) but
  // not yet drawn, and its size does not depend on where it is placed.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const tooltip = tooltipRef.current;
    if (!open || root === null || tooltip === null) return;
    const viewport = document.documentElement;
    const next = placePreviewTooltip(
      root.getBoundingClientRect(),
      tooltip.getBoundingClientRect(),
      {
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      },
    );
    setPlacement((current) =>
      current.side === next.side && current.align === next.align ? current : next,
    );
  }, [open]);

  return {
    open,
    placement,
    rootRef,
    tooltipRef,
    rootProps: {
      onMouseEnter: () => dispatch('pointer-enter'),
      onMouseLeave: () => dispatch('pointer-leave'),
    },
    triggerProps: {
      onFocus: () => dispatch('focus'),
      onBlur: () => dispatch('blur'),
      onClick: () => dispatch('press'),
      onKeyDown: (event) => {
        if (event.key !== 'Escape' || !open) return;
        event.stopPropagation();
        dispatch('dismiss');
      },
    },
  };
}
