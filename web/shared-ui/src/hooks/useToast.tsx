import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

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
}

// ============================================================================
// Provider-based toast state (single aria-live surface for the whole app)
// ============================================================================

const ToastContext = createContext<UseToastReturn | null>(null);

/** Internal hook holding the actual toast list + scheduling logic. */
function useToastState(): UseToastReturn {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((options: ToastOptions) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const newToast: Toast = { ...options, id };

    setToasts((prev) => [...prev, newToast]);

    const duration = options.duration ?? 5000;
    if (duration > 0) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, duration);
    }
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return useMemo(() => ({ toast, toasts, dismiss }), [toast, toasts, dismiss]);
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
      <ToastContainer toasts={state.toasts} onDismiss={state.dismiss} />
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
  success: 'bg-green-50 border-green-400 text-green-800',
  error: 'bg-red-50 border-red-400 text-red-800',
  warning: 'bg-yellow-50 border-yellow-400 text-yellow-800',
  info: 'bg-blue-50 border-blue-400 text-blue-800',
};

const ToastCard: React.FC<{ toast: Toast; onDismiss: (id: string) => void }> = ({
  toast: t,
  onDismiss,
}) => {
  const style = variantStyles[t.variant ?? 'info'];
  return (
    <div className={`border-l-4 rounded-lg p-4 shadow-lg ${style} pointer-events-auto`}>
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
          aria-label="Dismiss notification"
        >
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
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
}> = ({ toasts, onDismiss }) => {
  const polite = toasts.filter((t) => t.variant !== 'error');
  const assertive = toasts.filter((t) => t.variant === 'error');

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
      <div aria-live="polite" aria-atomic="true" role="status" className="flex flex-col gap-2">
        {polite.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
        ))}
      </div>
      <div aria-live="assertive" aria-atomic="true" role="alert" className="flex flex-col gap-2">
        {assertive.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
        ))}
      </div>
    </div>
  );
};
