/**
 * ViewOverlayManager — Manages dialog / card / iframe overlays in the
 * SCADA HMI operator shell.
 *
 * Reads `activeOverlays` from the operator store and renders each one:
 *
 *   dialog — centred modal with semi-transparent backdrop.
 *            The backdrop click closes the dialog.
 *            Traps focus (ESC closes).
 *
 *   card   — draggable floating panel positioned at overlay.position.
 *            Drag handle is the title bar; dragging uses CSS transform.
 *            Clicking the card body brings it to front (z-index bump).
 *            Resizable via the browser's built-in resize handle.
 *
 *   iframe — resizable iframe with a title bar and close button.
 *            Navigates to overlay.url.
 *            Title bar also allows dragging.
 *
 * Z-index management: overlays store their own zIndex field; clicking
 * any overlay calls bringOverlayToFront() which bumps its zIndex to
 * max + 1 so it surfaces above others.
 *
 * The base z-index for overlays is 40 (above shell chrome which is ~30).
 */

import React, {
  useCallback,
  useRef,
  useState,
  useEffect,
  memo,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import { X, GripHorizontal, Maximize2, Minimize2 } from 'lucide-react';

import { useOperatorStore } from '../../store/scada/operatorStore';
import type { ViewOverlay } from '../../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Z-index base for overlays (above shell chrome)                     */
/* ------------------------------------------------------------------ */

const OVERLAY_Z_BASE = 40;

/* ------------------------------------------------------------------ */
/*  Focus trap hook                                                     */
/* ------------------------------------------------------------------ */

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Traps keyboard focus within a container element while active.
 * On mount, saves the previously focused element and focuses the first
 * focusable child. On unmount (or when active becomes false), restores
 * focus to the previously focused element.
 */
function useFocusTrap(
  containerRef: React.RefObject<HTMLElement | null>,
  active: boolean,
): void {
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;

    // Save the element that was focused before the trap activated
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    const container = containerRef.current;
    if (!container) return;

    // Focus the first focusable element inside the container
    const focusableElements = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusableElements.length > 0) {
      focusableElements[0].focus();
    } else {
      // If no focusable children, make the container itself focusable
      container.setAttribute('tabindex', '-1');
      container.focus();
    }

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;

      const focusable = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable.length === 0) return;

      const firstElement = focusable[0];
      const lastElement = focusable[focusable.length - 1];

      if (e.shiftKey) {
        // Shift+Tab: if focus is on the first element, wrap to last
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement.focus();
        }
      } else {
        // Tab: if focus is on the last element, wrap to first
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);

      // Restore focus to the previously focused element
      if (previouslyFocusedRef.current && typeof previouslyFocusedRef.current.focus === 'function') {
        previouslyFocusedRef.current.focus();
      }
    };
  }, [active, containerRef]);
}

/* ------------------------------------------------------------------ */
/*  Draggable title-bar hook                                           */
/* ------------------------------------------------------------------ */

interface DragState {
  offsetX: number;
  offsetY: number;
}

interface UseDragResult {
  dragRef: React.RefObject<HTMLDivElement | null>;
  translateX: number;
  translateY: number;
}

function useDraggable(
  initialX: number,
  initialY: number,
): UseDragResult {
  const [translate, setTranslate] = useState({ x: initialX, y: initialY });
  const dragRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef<DragState | null>(null);

  const handlePointerDown = useCallback(
    (e: PointerEvent) => {
      e.preventDefault();
      const el = dragRef.current;
      if (!el) return;

      // The element's rendered position is tracked via translate state.
      dragState.current = {
        offsetX: e.clientX - translate.x,
        offsetY: e.clientY - translate.y,
      };
      el.setPointerCapture(e.pointerId);
    },
    [translate.x, translate.y],
  );

  const handlePointerMove = useCallback((e: PointerEvent) => {
    if (!dragState.current) return;
    setTranslate({
      x: e.clientX - dragState.current.offsetX,
      y: e.clientY - dragState.current.offsetY,
    });
  }, []);

  const handlePointerUp = useCallback(() => {
    dragState.current = null;
  }, []);

  useEffect(() => {
    const el = dragRef.current;
    if (!el) return;

    el.addEventListener('pointerdown', handlePointerDown);
    el.addEventListener('pointermove', handlePointerMove);
    el.addEventListener('pointerup', handlePointerUp);
    el.addEventListener('pointercancel', handlePointerUp);

    return () => {
      el.removeEventListener('pointerdown', handlePointerDown);
      el.removeEventListener('pointermove', handlePointerMove);
      el.removeEventListener('pointerup', handlePointerUp);
      el.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [handlePointerDown, handlePointerMove, handlePointerUp]);

  return { dragRef, translateX: translate.x, translateY: translate.y };
}

/* ------------------------------------------------------------------ */
/*  OverlayTitleBar — shared drag handle + close button                */
/* ------------------------------------------------------------------ */

interface OverlayTitleBarProps {
  title?: string;
  dragHandleRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  className?: string;
}

const OverlayTitleBar = memo<OverlayTitleBarProps>(
  ({ title, dragHandleRef, onClose, className = '' }) => (
    <div
      ref={dragHandleRef as React.RefObject<HTMLDivElement>}
      className={[
        'flex items-center gap-2 px-3 py-2 bg-gray-800 border-b border-gray-700',
        'cursor-grab active:cursor-grabbing select-none shrink-0',
        className,
      ].join(' ')}
      aria-label="Drag to move"
    >
      <GripHorizontal
        size={14}
        className="text-gray-500 shrink-0"
        aria-hidden="true"
      />
      <span className="flex-1 truncate text-xs font-medium text-gray-200">
        {title ?? 'Overlay'}
      </span>
      <button
        type="button"
        onClick={onClose}
        className="
          flex items-center justify-center w-5 h-5 rounded shrink-0
          text-gray-400 hover:text-gray-100 hover:bg-gray-700 transition-colors
          focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-400
        "
        aria-label="Close overlay"
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  ),
);
OverlayTitleBar.displayName = 'OverlayTitleBar';

/* ------------------------------------------------------------------ */
/*  DialogOverlay — centred modal                                       */
/* ------------------------------------------------------------------ */

interface OverlayItemProps {
  overlay: ViewOverlay;
  onClose: (id: string) => void;
  onBringToFront: (id: string) => void;
}

const DialogOverlay = memo<OverlayItemProps>(
  ({ overlay, onClose, onBringToFront }) => {
    const { dragRef, translateX, translateY } = useDraggable(0, 0);
    const dialogContainerRef = useRef<HTMLDivElement>(null);

    const defaultWidth  = overlay.size?.width  ?? 640;
    const defaultHeight = overlay.size?.height ?? 480;

    const handleClose    = useCallback(() => onClose(overlay.id), [onClose, overlay.id]);
    const handleActivate = useCallback(() => onBringToFront(overlay.id), [onBringToFront, overlay.id]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') handleClose();
      },
      [handleClose],
    );

    // Focus trap: keeps Tab cycling within the dialog, restores focus on close
    useFocusTrap(dialogContainerRef, true);

    return (
      /* Backdrop */
      <div
        ref={dialogContainerRef}
        className="fixed inset-0 flex items-center justify-center"
        style={{ zIndex: OVERLAY_Z_BASE + overlay.zIndex }}
        aria-modal="true"
        role="dialog"
        aria-label={overlay.title ?? 'Dialog'}
        onKeyDown={handleKeyDown}
      >
        {/* Semi-transparent backdrop */}
        <div
          className="absolute inset-0 bg-black/50"
          onClick={handleClose}
          aria-hidden="true"
        />

        {/* Dialog panel */}
        <div
          className="relative flex flex-col bg-gray-900 border border-gray-700 rounded-lg shadow-2xl overflow-hidden"
          style={{
            width:     defaultWidth,
            height:    defaultHeight,
            transform: `translate(${translateX}px, ${translateY}px)`,
          }}
          onPointerDown={handleActivate}
        >
          <OverlayTitleBar
            title={overlay.title}
            dragHandleRef={dragRef}
            onClose={handleClose}
          />

          {/* Content */}
          <div className="flex-1 overflow-auto bg-gray-950 p-0">
            {overlay.url ? (
              <iframe
                src={overlay.url}
                className="w-full h-full border-0"
                title={overlay.title ?? 'Dialog content'}
                sandbox="allow-scripts allow-same-origin allow-forms"
              />
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500 text-sm">
                Screen: {overlay.screenId ?? '—'}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  },
);
DialogOverlay.displayName = 'DialogOverlay';

/* ------------------------------------------------------------------ */
/*  CardOverlay — draggable floating panel                              */
/* ------------------------------------------------------------------ */

const CardOverlay = memo<OverlayItemProps>(
  ({ overlay, onClose, onBringToFront }) => {
    const { dragRef, translateX, translateY } = useDraggable(
      overlay.position.x,
      overlay.position.y,
    );

    const [maximised, setMaximised] = useState(false);
    const defaultWidth  = overlay.size?.width  ?? 400;
    const defaultHeight = overlay.size?.height ?? 320;

    const handleClose    = useCallback(() => onClose(overlay.id), [onClose, overlay.id]);
    const handleActivate = useCallback(() => onBringToFront(overlay.id), [onBringToFront, overlay.id]);

    return (
      <div
        className={[
          'fixed flex flex-col bg-gray-900 border border-gray-700 rounded-lg shadow-2xl overflow-hidden',
          maximised ? '' : 'resize',
        ].join(' ')}
        style={
          maximised
            ? { inset: 64, zIndex: OVERLAY_Z_BASE + overlay.zIndex }
            : {
                left:      0,
                top:       0,
                width:     defaultWidth,
                height:    defaultHeight,
                zIndex:    OVERLAY_Z_BASE + overlay.zIndex,
                transform: `translate(${translateX}px, ${translateY}px)`,
                minWidth:  200,
                minHeight: 120,
              }
        }
        onPointerDown={handleActivate}
        role="region"
        aria-label={overlay.title ?? 'Floating card'}
      >
        <OverlayTitleBar
          title={overlay.title}
          dragHandleRef={dragRef}
          onClose={handleClose}
          className="rounded-t-lg"
        />

        {/* Maximise toggle */}
        <button
          type="button"
          onClick={() => setMaximised((v) => !v)}
          className="
            absolute right-8 top-1.5
            flex items-center justify-center w-5 h-5 rounded
            text-gray-400 hover:text-gray-100 hover:bg-gray-700 transition-colors
            focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-400
          "
          aria-label={maximised ? 'Restore card' : 'Maximise card'}
        >
          {maximised
            ? <Minimize2 size={11} aria-hidden="true" />
            : <Maximize2 size={11} aria-hidden="true" />
          }
        </button>

        {/* Content */}
        <div className="flex-1 overflow-auto bg-gray-950">
          {overlay.url ? (
            <iframe
              src={overlay.url}
              className="w-full h-full border-0"
              title={overlay.title ?? 'Card content'}
              sandbox="allow-scripts allow-same-origin allow-forms"
            />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">
              Screen: {overlay.screenId ?? '—'}
            </div>
          )}
        </div>
      </div>
    );
  },
);
CardOverlay.displayName = 'CardOverlay';

/* ------------------------------------------------------------------ */
/*  IframeOverlay — resizable iframe with title bar                    */
/* ------------------------------------------------------------------ */

const IframeOverlay = memo<OverlayItemProps>(
  ({ overlay, onClose, onBringToFront }) => {
    const { dragRef, translateX, translateY } = useDraggable(
      overlay.position.x,
      overlay.position.y,
    );

    const defaultWidth  = overlay.size?.width  ?? 800;
    const defaultHeight = overlay.size?.height ?? 600;

    const handleClose    = useCallback(() => onClose(overlay.id), [onClose, overlay.id]);
    const handleActivate = useCallback(() => onBringToFront(overlay.id), [onBringToFront, overlay.id]);

    return (
      <div
        className="fixed flex flex-col bg-gray-900 border border-gray-700 rounded-lg shadow-2xl overflow-hidden resize"
        style={{
          left:      0,
          top:       0,
          width:     defaultWidth,
          height:    defaultHeight,
          zIndex:    OVERLAY_Z_BASE + overlay.zIndex,
          transform: `translate(${translateX}px, ${translateY}px)`,
          minWidth:  300,
          minHeight: 200,
        }}
        onPointerDown={handleActivate}
        role="region"
        aria-label={overlay.title ?? 'Iframe overlay'}
      >
        <OverlayTitleBar
          title={overlay.title ?? overlay.url ?? 'External page'}
          dragHandleRef={dragRef}
          onClose={handleClose}
          className="rounded-t-lg"
        />

        <div className="flex-1 overflow-hidden">
          {overlay.url ? (
            <iframe
              src={overlay.url}
              className="w-full h-full border-0"
              title={overlay.title ?? 'Iframe overlay'}
              // Intentionally permissive for trusted internal URLs.
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">
              No URL configured
            </div>
          )}
        </div>
      </div>
    );
  },
);
IframeOverlay.displayName = 'IframeOverlay';

/* ------------------------------------------------------------------ */
/*  ViewOverlayManager                                                  */
/* ------------------------------------------------------------------ */

export const ViewOverlayManager = memo(() => {
  const { activeOverlays, closeOverlay, bringOverlayToFront } =
    useOperatorStore(
      useShallow((s) => ({
        activeOverlays:     s.activeOverlays,
        closeOverlay:       s.closeOverlay,
        bringOverlayToFront: s.bringOverlayToFront,
      })),
    );

  if (activeOverlays.length === 0) return null;

  return (
    <>
      {activeOverlays.map((overlay) => {
        switch (overlay.type) {
          case 'dialog':
            return (
              <DialogOverlay
                key={overlay.id}
                overlay={overlay}
                onClose={closeOverlay}
                onBringToFront={bringOverlayToFront}
              />
            );
          case 'card':
            return (
              <CardOverlay
                key={overlay.id}
                overlay={overlay}
                onClose={closeOverlay}
                onBringToFront={bringOverlayToFront}
              />
            );
          case 'iframe':
            return (
              <IframeOverlay
                key={overlay.id}
                overlay={overlay}
                onClose={closeOverlay}
                onBringToFront={bringOverlayToFront}
              />
            );
          default:
            return null;
        }
      })}
    </>
  );
});
ViewOverlayManager.displayName = 'ViewOverlayManager';
