/**
 * KioskMode — Full-screen kiosk wrapper for the SCADA HMI operator shell.
 *
 * Features:
 *  - Enters browser Fullscreen API on mount (or on user gesture).
 *  - Hides the mouse cursor after 3 seconds of inactivity.
 *  - Exit: ESC key (native browser exits fullscreen), or triple-tap on
 *    touch devices within 600ms.
 *  - Black background, no scrollbars.
 *  - Fires onExit when fullscreen is exited by the user or browser.
 *
 * Usage:
 *   <KioskMode onExit={() => setKioskMode(false)}>
 *     <OperatorView ... />
 *   </KioskMode>
 *
 * Note: Some browsers require fullscreen to be triggered by a direct
 * user gesture.  If the initial requestFullscreen() is rejected (e.g.
 * because the component mounted without a gesture), KioskMode still
 * works: it hides cursor + disables scrollbars; the fullscreen call is
 * simply skipped.
 */

import React, {
  useEffect,
  useRef,
  useCallback,
  useState,
  type ReactNode,
} from 'react';
import { Minimize2 } from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Props                                                               */
/* ------------------------------------------------------------------ */

export interface KioskModeProps {
  /** Content to render in kiosk mode. */
  children: ReactNode;
  /**
   * Called when the user exits kiosk mode (ESC / triple-tap / fullscreen
   * change event). The parent should set kioskMode = false in response.
   */
  onExit?: () => void;
  /**
   * Milliseconds of inactivity before the cursor is hidden.
   * Defaults to 3000 ms.
   */
  cursorHideDelay?: number;
  /**
   * Whether to attempt to enter the browser Fullscreen API.
   * Defaults to true. Set to false if you manage fullscreen externally.
   */
  requestFullscreen?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Fullscreen helpers (vendor-prefixed fallbacks)                     */
/* ------------------------------------------------------------------ */

function enterFullscreen(el: HTMLElement): Promise<void> {
  if (el.requestFullscreen) return el.requestFullscreen();
  // Safari
  const safariFn = (el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> })
    .webkitRequestFullscreen;
  if (safariFn) return safariFn.call(el);
  return Promise.resolve();
}

function exitFullscreen(): Promise<void> {
  if (document.exitFullscreen) return document.exitFullscreen();
  const safariExit = (
    document as Document & { webkitExitFullscreen?: () => Promise<void> }
  ).webkitExitFullscreen;
  if (safariExit) return safariExit.call(document);
  return Promise.resolve();
}

function isInFullscreen(): boolean {
  return !!(
    document.fullscreenElement ||
    (document as Document & { webkitFullscreenElement?: Element })
      .webkitFullscreenElement
  );
}

/* ------------------------------------------------------------------ */
/*  KioskMode                                                           */
/* ------------------------------------------------------------------ */

export const KioskMode = React.memo<KioskModeProps>(
  ({
    children,
    onExit,
    cursorHideDelay = 3000,
    requestFullscreen: shouldRequestFullscreen = true,
  }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const cursorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const tapTimestampsRef = useRef<number[]>([]);

    const [cursorHidden, setCursorHidden] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);

    // ── Cursor hide/show logic ───────────────────────────────────────

    const showCursor = useCallback(() => {
      setCursorHidden(false);
      if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current);
      cursorTimerRef.current = setTimeout(() => {
        setCursorHidden(true);
      }, cursorHideDelay);
    }, [cursorHideDelay]);

    // Start the hide timer when component mounts
    useEffect(() => {
      showCursor();
      return () => {
        if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current);
      };
    }, [showCursor]);

    // ── Fullscreen management ────────────────────────────────────────

    // Attempt to enter fullscreen on mount
    useEffect(() => {
      if (!shouldRequestFullscreen || !containerRef.current) return;

      enterFullscreen(containerRef.current).then(() => {
        setIsFullscreen(true);
      }).catch(() => {
        // Gesture requirement not met — continue without fullscreen.
        setIsFullscreen(false);
      });

      return () => {
        // Exit fullscreen when kiosk mode is unmounted
        if (isInFullscreen()) {
          void exitFullscreen();
        }
      };
     
    }, [shouldRequestFullscreen]);

    // Listen for external fullscreen exit (ESC key, browser UI, etc.)
    useEffect(() => {
      const handleFsChange = () => {
        const nowFullscreen = isInFullscreen();
        setIsFullscreen(nowFullscreen);
        if (!nowFullscreen) {
          onExit?.();
        }
      };

      document.addEventListener('fullscreenchange', handleFsChange);
      document.addEventListener('webkitfullscreenchange', handleFsChange);
      return () => {
        document.removeEventListener('fullscreenchange', handleFsChange);
        document.removeEventListener('webkitfullscreenchange', handleFsChange);
      };
    }, [onExit]);

    // ── Triple-tap to exit (touch devices) ──────────────────────────

    const handleTouchEnd = useCallback(() => {
      const now = Date.now();
      const taps = tapTimestampsRef.current;

      taps.push(now);
      // Keep only the last 3 taps within the 600ms window
      const recent = taps.filter((t) => now - t < 600);
      tapTimestampsRef.current = recent;

      if (recent.length >= 3) {
        tapTimestampsRef.current = [];
        if (isInFullscreen()) void exitFullscreen();
        onExit?.();
      }

      // Show cursor on touch (treat as activity)
      showCursor();
    }, [onExit, showCursor]);

    // ── Keyboard shortcut: ESC exits the shell kiosk mode           --
    // (Browser natively exits fullscreen on ESC; we additionally     --
    //  call onExit so the shell toggles kioskMode = false.)          --

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Escape') {
          if (isInFullscreen()) void exitFullscreen();
          onExit?.();
        }
        showCursor();
      },
      [onExit, showCursor],
    );

    // ── Mouse/pointer activity → show cursor ────────────────────────

    const handlePointerMove = useCallback(() => {
      showCursor();
    }, [showCursor]);

    return (
      <div
        ref={containerRef}
        className={[
          'fixed inset-0 bg-black z-50 overflow-hidden focus:outline-hidden',
          cursorHidden ? 'cursor-none' : 'cursor-default',
        ].join(' ')}
        tabIndex={-1}
        role="application"
        aria-label="Kiosk mode view"
        onKeyDown={handleKeyDown}
        onPointerMove={handlePointerMove}
        onTouchEnd={handleTouchEnd}
      >
        {children}

        {/* Exit button — visible only while cursor is shown */}
        {!cursorHidden && (
          <button
            type="button"
            onClick={() => {
              if (isInFullscreen()) void exitFullscreen();
              onExit?.();
            }}
            className="
              absolute top-3 right-3 z-10
              flex items-center gap-1.5 px-2.5 py-1.5 rounded-md
              bg-black/70 text-gray-300 text-xs
              hover:bg-gray-800 hover:text-gray-100
              transition-colors border border-gray-700
              focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-400
            "
            aria-label="Exit kiosk mode"
          >
            <Minimize2 size={13} aria-hidden="true" />
            <span>Exit kiosk</span>
          </button>
        )}

        {/* Fullscreen indicator (dev/diagnostic) */}
        {process.env.NODE_ENV === 'development' && (
          <div className="absolute bottom-2 left-2 text-[10px] text-gray-700 pointer-events-none select-none">
            {isFullscreen ? 'fullscreen' : 'windowed'} kiosk
          </div>
        )}
      </div>
    );
  },
);
KioskMode.displayName = 'KioskMode';
