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
 *
 * WHY this file imports NO UI kit (v4): it is the app's last line of defence and
 * renders precisely when the rest of the tree has thrown. Every import it takes
 * is code that must not itself throw while the fallback is being rendered, so
 * the surface, the alarm well and the retry button are hand-written from the
 * SAME semantic tokens the kit uses (bg-surface-1 / border-line / shadow-token,
 * bg-crit-dim + text-crit, bg-acc + text-acc-on) rather than imported from it.
 * Duplicating four class strings is the price of a fallback that cannot fail.
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

      // No ground colour of its own: <body> paints `var(--bg)` from
      // src/styles/main.css, which is plain CSS and therefore still correct on
      // the render that this boundary is catching.
      return (
        <div
          className="min-h-screen flex items-center justify-center px-6"
          role="alert"
          aria-live="assertive"
        >
          <div className="bg-surface-1 border border-line rounded-2xl shadow-token p-8 max-w-sm w-full text-center">
            {/* WHY: the alarm well plus a raised card is the app's alert pattern
                (HomePage's over-capacity warning) -- consistent visual language.
                Coral is the alarm colour, and a crash is an alarm. */}
            <div className="w-14 h-14 bg-crit-dim rounded-2xl flex items-center justify-center mx-auto mb-4">
              <AlertTriangle size={28} className="text-crit" />
            </div>
            <h1 className="text-head font-bold text-ink-1 mb-2">{title}</h1>
            <p className="text-body text-ink-2 mb-6 leading-relaxed">{message}</p>
            <button
              onClick={this.handleRetry}
              className="w-full min-h-touch bg-acc text-acc-on font-bold text-body rounded-xl px-6 py-3 touch-feedback shadow-acc transition-all motion-safe:active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc"
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
