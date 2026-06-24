/**
 * Canonical process-lifecycle timer handle. WHY a single type: in Node both
 * setTimeout and setInterval return the identical NodeJS.Timeout handle, so a
 * `ManagedTimeout | ManagedInterval` union duplicates one constituent
 * (@typescript-eslint/no-duplicate-type-constituents). The timeout-vs-interval
 * distinction lives in the create* function names, not the handle type; the two
 * aliases below stay for call-site readability.
 */
export type ManagedTimer = ReturnType<typeof setTimeout>;
export type ManagedTimeout = ManagedTimer;
export type ManagedInterval = ManagedTimer;

interface UnrefableTimer {
  unref?: () => void;
}

export interface ManagedAbortTimeout {
  readonly signal: AbortSignal;
  abort(): void;
  clear(): void;
}

function unrefTimer<T extends UnrefableTimer>(timer: T): T {
  timer.unref?.();
  return timer;
}

export function createManagedTimeout(callback: () => void, timeoutMs: number): ManagedTimeout {
  return unrefTimer(setTimeout(callback, timeoutMs));
}

export function createManagedInterval(callback: () => void, intervalMs: number): ManagedInterval {
  return unrefTimer(setInterval(callback, intervalMs));
}

export function clearManagedTimer(timer: ManagedTimer | null | undefined): void {
  if (!timer) return;
  clearTimeout(timer);
}

export function createAbortSignalTimeout(timeoutMs: number): ManagedAbortTimeout {
  const controller = new AbortController();
  let timer: ManagedTimeout | null =
    timeoutMs > 0 ? createManagedTimeout(() => controller.abort(), timeoutMs) : null;

  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    clear: () => {
      clearManagedTimer(timer);
      timer = null;
    },
  };
}
