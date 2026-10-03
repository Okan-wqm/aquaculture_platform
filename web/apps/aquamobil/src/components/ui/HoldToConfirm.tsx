/**
 * HoldToConfirm — press and hold to commit an entry.
 *
 * WHY a hold rather than a tap: these entries are irreversible farm records
 * (a mortality count, a harvest, a transfer) written to an offline queue that
 * will sync without further confirmation. A tap is one glove brush away from a
 * false record, and a confirm dialog after every entry costs a second tap on
 * every correct one. Holding makes the accidental case impossible and the
 * deliberate case one gesture — Tier 1 rather than a warning nobody reads.
 *
 * The fill IS the feedback: the button fills over the hold duration, so the
 * worker sees commitment building and can abort by lifting.
 *
 * Under prefers-reduced-motion the fill still runs — it is state, not
 * decoration. Only its transition smoothing is dropped by the global rule.
 */
import { clsx } from 'clsx';
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

export interface HoldToConfirmProps {
  onConfirm: () => void;
  /** Hold duration. 700ms reads as deliberate without feeling stuck. */
  durationMs?: number;
  disabled?: boolean;
  /** Idle label, e.g. "Hold to save". */
  children: ReactNode;
  className?: string;
}

/** Progress tick — 60fps is wasted on a bar this size; 20ms is smooth enough. */
const TICK_MS = 20;

export function HoldToConfirm({
  onConfirm,
  durationMs = 700,
  disabled = false,
  children,
  className,
}: HoldToConfirmProps): ReactElement {
  const [progress, setProgress] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Held in a ref so the interval callback always sees the live handler without
  // being torn down and rebuilt on every parent render.
  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;

  const stop = useCallback((): void => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setProgress(0);
  }, []);

  const start = useCallback((): void => {
    if (disabled || timerRef.current !== null) return;
    const startedAt = Date.now();
    timerRef.current = setInterval(() => {
      const pct = Math.min(100, ((Date.now() - startedAt) / durationMs) * 100);
      setProgress(pct);
      if (pct >= 100) {
        stop();
        onConfirmRef.current();
      }
    }, TICK_MS);
  }, [disabled, durationMs, stop]);

  // A component unmounted mid-hold (the sheet closing under it) must not leave
  // an interval running that then fires onConfirm into a dead tree.
  useEffect(() => stop, [stop]);

  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      // Keyboard parity: holding Space/Enter is not a gesture keyboards express,
      // so for keyboard users the action commits on a normal activation.
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat && !disabled) {
          e.preventDefault();
          onConfirmRef.current();
        }
      }}
      className={clsx(
        'relative w-full h-tap-save min-h-touch overflow-hidden rounded-2xl',
        'text-title font-semibold bg-acc text-acc-on shadow-acc',
        'touch-feedback focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc',
        'disabled:opacity-50 disabled:pointer-events-none',
        className,
      )}
    >
      <span
        aria-hidden
        style={{ width: `${progress}%` }}
        className="absolute inset-y-0 left-0 bg-black/25"
      />
      <span className="relative">{children}</span>
    </button>
  );
}
