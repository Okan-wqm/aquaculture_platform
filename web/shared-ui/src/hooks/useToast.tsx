import React, { useState, useCallback } from 'react';

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: 'success' | 'error' | 'warning' | 'info';
  duration?: number;
}

interface Toast extends ToastOptions {
  id: string;
}

interface UseToastReturn {
  toast: (options: ToastOptions) => void;
  toasts: Toast[];
  dismiss: (id: string) => void;
}

export function useToast(): UseToastReturn {
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

  return { toast, toasts, dismiss };
}

// ============================================================================
// Toast Container Component (aria-live region for screen readers)
// ============================================================================

const variantStyles: Record<string, string> = {
  success: 'bg-green-50 border-green-400 text-green-800',
  error: 'bg-red-50 border-red-400 text-red-800',
  warning: 'bg-yellow-50 border-yellow-400 text-yellow-800',
  info: 'bg-blue-50 border-blue-400 text-blue-800',
};

/**
 * ToastContainer renders the toast list inside an aria-live region
 * so screen readers announce new toasts automatically.
 *
 * @example
 * const { toast, toasts, dismiss } = useToast();
 * return <ToastContainer toasts={toasts} onDismiss={dismiss} />;
 */
export const ToastContainer: React.FC<{
  toasts: Toast[];
  onDismiss: (id: string) => void;
}> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) {
    // Keep the aria-live region in the DOM so future toasts are announced
    return (
      <div
        aria-live="polite"
        aria-atomic="true"
        className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"
      />
    );
  }

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      role="status"
      className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full"
    >
      {toasts.map((t) => {
        const style = variantStyles[t.variant ?? 'info'];
        return (
          <div
            key={t.id}
            className={`border-l-4 rounded-lg p-4 shadow-lg ${style} pointer-events-auto`}
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm font-semibold">{t.title}</p>
                {t.description && (
                  <p className="mt-1 text-sm opacity-90">{t.description}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => onDismiss(t.id)}
                className="ml-3 inline-flex rounded-md p-1 hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-offset-2"
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
      })}
    </div>
  );
};
