import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

import { useI18n } from '../i18n';
import { X } from 'lucide-react';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: 'success' | 'error' | 'warning' | 'info';
  duration?: number;
  /** Optional action button (e.g. Retry) rendered inside the toast. */
  action?: ToastAction;
}

interface Toast extends ToastOptions {
  id: string;
}

interface UseToastReturn {
  toast: (options: ToastOptions) => void;
  toasts: Toast[];
  dismiss: (id: string) => void;
  /** Hold every auto-dismiss timer (the container calls this while a toast is hovered or focused). */
  pause: () => void;
  /** Restart the auto-dismiss timers held by `pause`. */
  resume: () => void;
}

/**
 * How long a toast stays before dismissing itself. A toast carrying an
 * action (Retry, Undo) never auto-dismisses — the control has to stay
 * reachable (WCAG 2.2.1); an error gets twice the default; everything else 5 s.
 */
function autoDismissAfter(toast: ToastOptions): number {
  if (toast.duration !== undefined) return toast.duration;
  if (toast.action) return 0;
  return toast.variant === 'error' ? 10000 : 5000;
}

// ============================================================================
// Provider-based toast state (single aria-live surface for the whole app)
// ============================================================================

const ToastContext = createContext<UseToastReturn | null>(null);

/** Internal hook holding the actual toast list + scheduling logic. */
function useToastState(): UseToastReturn {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // The live list and the timers live in refs so pause/resume never depend on
  // a stale render: a timer is keyed by toast id and cleared with the toast.
  const toastsRef = useRef<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const paused = useRef(false);

  const commit = useCallback((next: (prev: Toast[]) => Toast[]) => {
    setToasts((prev) => {
      const updated = next(prev);
      toastsRef.current = updated;
      return updated;
    });
  }, []);

  const clearTimer = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const schedule = useCallback(
    (t: Toast) => {
      const duration = autoDismissAfter(t);
      if (duration <= 0 || paused.current) return;
      clearTimer(t.id);
      timers.current.set(
        t.id,
        setTimeout(() => {
          timers.current.delete(t.id);
          commit((prev) => prev.filter((x) => x.id !== t.id));
        }, duration),
      );
    },
    [clearTimer, commit],
  );

  const toast = useCallback(
    (options: ToastOptions) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const newToast: Toast = { ...options, id };
      commit((prev) => [...prev, newToast]);
      schedule(newToast);
    },
    [commit, schedule],
  );

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id);
      commit((prev) => prev.filter((t) => t.id !== id));
    },
    [clearTimer, commit],
  );

  const pause = useCallback(() => {
    paused.current = true;
    for (const id of [...timers.current.keys()]) clearTimer(id);
  }, [clearTimer]);

  const resume = useCallback(() => {
    paused.current = false;
    for (const t of toastsRef.current) schedule(t);
  }, [schedule]);

  return useMemo(
    () => ({ toast, toasts, dismiss, pause, resume }),
    [toast, toasts, dismiss, pause, resume],
  );
}

/**
 * App-level toast provider. Mount ONCE in the host (shell) provider tree —
 * via the Module Federation singleton React, the context reaches every
 * federated remote, so any `useToast()` call anywhere renders into the single
 * container this provider owns.
 *
 * The container is rendered after `children` so toasts stack above page
 * content without portals.
 */
export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const state = useToastState();
  return (
    <ToastContext.Provider value={state}>
      {children}
      <ToastContainer
        toasts={state.toasts}
        onDismiss={state.dismiss}
        onPause={state.pause}
        onResume={state.resume}
      />
    </ToastContext.Provider>
  );
};

/**
 * Toast API. Under a `ToastProvider` (the shell mounts one) all callers share
 * the app-level toast surface. Without a provider (standalone module dev
 * harnesses, isolated component tests) it degrades to the legacy
 * per-component state so existing render patterns keep working — in that mode
 * the caller must render `<ToastContainer toasts={toasts} onDismiss={dismiss}/>`
 * itself, exactly as before.
 */
export function useToast(): UseToastReturn {
  const ctx = useContext(ToastContext);
  // Hook order is stable: the local fallback state is created on every render
  // regardless of context presence, and simply unused when a provider exists.
  const local = useToastState();
  return ctx ?? local;
}

// ============================================================================
// Toast Container Component (aria-live regions for screen readers)
// ============================================================================

const variantStyles: Record<string, string> = {
  success:
    'bg-success-50 dark:bg-success-900/20 border-success-400 text-success-800 dark:text-success-200',
  error: 'bg-error-50 dark:bg-error-900/20 border-error-400 text-error-800 dark:text-error-200',
  warning:
    'bg-warning-50 dark:bg-warning-900/20 border-warning-400 text-warning-800 dark:text-warning-200',
  info: 'bg-info-50 dark:bg-info-900/20 border-info-400 text-info-800 dark:text-info-200',
};

const ToastCard: React.FC<{
  toast: Toast;
  onDismiss: (id: string) => void;
  onPause?: () => void;
  onResume?: () => void;
}> = ({ toast: t, onDismiss, onPause, onResume }) => {
  const { t: translate } = useI18n();
  const style = variantStyles[t.variant ?? 'info'];
  return (
    <div
      className={`border-l-4 rounded-lg p-4 shadow-lg ${style} pointer-events-auto`}
      onMouseEnter={onPause}
      onMouseLeave={onResume}
      onFocus={onPause}
      onBlur={onResume}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-semibold">{t.title}</p>
          {t.description && <p className="mt-1 text-sm opacity-90">{t.description}</p>}
          {t.action && (
            <button
              type="button"
              onClick={() => {
                t.action?.onClick();
                onDismiss(t.id);
              }}
              className="mt-2 text-sm font-semibold underline hover:opacity-80"
            >
              {t.action.label}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => onDismiss(t.id)}
          className="ml-3 inline-flex rounded-md p-1 hover:opacity-80 focus:outline-hidden focus:ring-2 focus:ring-offset-2"
          aria-label={translate('common.dismissNotification')}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};

/**
 * ToastContainer renders the toast list inside aria-live regions so screen
 * readers announce new toasts automatically. Errors are announced assertively
 * (they usually require action); everything else stays polite.
 *
 * When using `ToastProvider` (the app-wide pattern) this is rendered for you.
 * Render it manually only in the provider-less legacy/standalone mode.
 */
export const ToastContainer: React.FC<{
  toasts: Toast[];
  onDismiss: (id: string) => void;
  /** Hold auto-dismiss while a toast is hovered or focused (the provider wires these). */
  onPause?: () => void;
  onResume?: () => void;
}> = ({ toasts, onDismiss, onPause, onResume }) => {
  const polite = toasts.filter((t) => t.variant !== 'error');
  const assertive = toasts.filter((t) => t.variant === 'error');

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
      <div aria-live="polite" aria-atomic="true" role="status" className="flex flex-col gap-2">
        {polite.map((t) => (
          <ToastCard
            key={t.id}
            toast={t}
            onDismiss={onDismiss}
            onPause={onPause}
            onResume={onResume}
          />
        ))}
      </div>
      <div aria-live="assertive" aria-atomic="true" role="alert" className="flex flex-col gap-2">
        {assertive.map((t) => (
          <ToastCard
            key={t.id}
            toast={t}
            onDismiss={onDismiss}
            onPause={onPause}
            onResume={onResume}
          />
        ))}
      </div>
    </div>
  );
};
