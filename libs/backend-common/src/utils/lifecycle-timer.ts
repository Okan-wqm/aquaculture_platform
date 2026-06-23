export type ManagedTimeout = ReturnType<typeof setTimeout>;
export type ManagedInterval = ReturnType<typeof setInterval>;
export type ManagedTimer = ManagedTimeout | ManagedInterval;

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
  clearTimeout(timer as ManagedTimeout);
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
