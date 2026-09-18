import { AlertTriangle } from 'lucide-react';
import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';

import { logger } from '@/utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackTitle?: string;
  fallbackMessage?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * ErrorBoundary -- catches render errors in hub pages without crashing the
 * entire app shell.
 *
 * WHY class component: React error boundaries MUST be class components --
 * there is no hook equivalent for componentDidCatch / getDerivedStateFromError.
 *
 * WHY window.location.reload: In a PWA context, stale service worker caches
 * are the most common cause of unexpected render errors. A full reload clears
 * the React tree and forces the SW to serve fresh assets, which resolves the
 * majority of field-reported crashes without user confusion.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // WHY: Log through the structured logger (FE-HIGH-056) so field support can
    // capture the stack trace from remote debugging sessions without needing a
    // dedicated error reporting service (which may not be reachable on farm
    // networks). Routing through the logger keeps this off the banned `console.*`
    // path while staying observable — the crash is recorded, never silently
    // swallowed.
    logger.error('[ErrorBoundary] Uncaught render error:', error, errorInfo);
  }

  private handleRetry = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      const title = this.props.fallbackTitle ?? 'Something went wrong';
      const message =
        this.props.fallbackMessage ?? 'An unexpected error occurred. Please try again.';

      return (
        <div
          className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center px-6"
          role="alert"
          aria-live="assertive"
        >
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card p-8 max-w-sm w-full text-center">
            {/* WHY: Red icon + white card follows the existing alert pattern from
                HomePage's over-capacity warning -- consistent visual language. */}
            <div className="w-14 h-14 bg-red-50 dark:bg-red-900/20 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <AlertTriangle size={28} className="text-red-500" />
            </div>
            <h1 className="text-lg font-bold text-gray-900 dark:text-white mb-2">{title}</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6 leading-relaxed">
              {message}
            </p>
            <button
              onClick={this.handleRetry}
              className="w-full min-h-[44px] bg-gradient-to-br from-ocean-600 to-ocean-500 text-white font-bold text-sm rounded-xl px-6 py-3 touch-feedback shadow-card transition-all motion-safe:active:scale-[0.97]"
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
