/**
 * ErrorBoundary — the guard family's crash isolation component.
 *
 * One class-based boundary for module-level and page-level mounting: a render
 * crash inside a federated remote is contained where it happened (nav and the
 * rest of the shell survive) instead of unwinding to the host. Callers can
 * observe errors via `onError` (wire it to the module's reporting pipeline);
 * retry re-renders the subtree, refresh reloads the document, home navigates
 * to `homePath` with `location.replace` (SEC-008: no history pollution from a
 * crashed page).
 *
 * Restored from aria-karantina/kapsam-iadesi (dalga3-15) with three
 * main-gate conformance deltas: theme tokens instead of raw palette classes
 * (FE-HIGH-078), user-visible strings via the shared-ui i18n SSOT
 * (FE-HIGH-089 — en fallback preserves the quarantined spec's assertions),
 * and a lucide-react glyph instead of an inline SVG (inline-icon ceiling).
 * The user-facing body is the ERROR_MESSAGES SSOT's own value via
 * parseError(error).userMessage — no new generic message is invented here.
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../Button';
import { useI18n } from '../../i18n/I18nProvider';
import { parseError } from '../../utils/error-types';
import { logError } from '../../utils/log-error';
import { randomId } from '../../utils/random-id';
import { getLastCorrelationId } from '../../utils/api-client';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Module/section name shown in the error title. */
  moduleName?: string;
  /** Custom fallback rendered instead of the default error UI. */
  fallback?: ReactNode;
  /** Error observer for external handling/reporting. */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** Where "Go home" navigates (module root); default '/'. */
  homePath?: string;
}

/** i18n-resolved labels — the class core cannot call hooks itself. */
interface ErrorBoundaryLabels {
  titleWithModule: string;
  titleGeneric: string;
  retry: string;
  refresh: string;
  goHome: string;
  shareCode: string;
}

/** Retry budget — single family constant, aligned with the SCADA widget
 * renderer's MAX_RETRIES precedent (scada-builder/WidgetRenderer.tsx). */
const MAX_RESET_RETRIES = 3;

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorId: string | null;
  retryCount: number;
}

class ErrorBoundaryCore extends Component<
  ErrorBoundaryProps & { labels: ErrorBoundaryLabels; onResetQueries: () => void },
  ErrorBoundaryState
> {
  constructor(
    props: ErrorBoundaryProps & { labels: ErrorBoundaryLabels; onResetQueries: () => void },
  ) {
    super(props);
    this.state = { hasError: false, error: null, errorId: null, retryCount: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // The errorId is generated HERE (componentDidCatch may setState), printed
    // to the console via the family logger, and displayed on the card — a
    // screenshot-to-report key the user can share with support.
    const errorId = randomId();
    this.setState({ errorId });
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    } else {
      logError(`ErrorBoundary${this.props.moduleName ? `:${this.props.moduleName}` : ''}`, error, {
        errorId,
        componentStack: errorInfo.componentStack,
      });
    }
  }

  handleRetry = (): void => {
    // A deterministic data-shaped crash re-crashes instantly if the query
    // cache rehydrates the same payload, so a retry also resets the query
    // cache (fresh fetch) and draws from a bounded budget.
    this.props.onResetQueries();
    this.setState((state) => ({
      hasError: false,
      error: null,
      errorId: null,
      retryCount: state.retryCount + 1,
    }));
  };

  handleRefresh = (): void => {
    window.location.reload();
  };

  handleGoHome = (): void => {
    window.location.replace(this.props.homePath ?? '/');
  };

  render(): ReactNode {
    const { hasError, error, errorId, retryCount } = this.state;
    const { children, moduleName, fallback, labels } = this.props;
    const retriesExhausted = retryCount >= MAX_RESET_RETRIES;
    const correlationId = getLastCorrelationId();

    if (hasError) {
      if (fallback) {
        return fallback;
      }

      return (
        <div className="min-h-[400px] flex items-center justify-center p-8">
          <div className="text-center max-w-md">
            <div className="mx-auto w-16 h-16 bg-error-100 dark:bg-error-900/40 rounded-full flex items-center justify-center mb-4">
              <AlertTriangle
                className="w-8 h-8 text-error-600 dark:text-error-400"
                aria-hidden="true"
              />
            </div>

            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
              {moduleName
                ? labels.titleWithModule.split('{module}').join(moduleName)
                : labels.titleGeneric}
            </h2>

            {/* The ERROR_MESSAGES SSOT owns this text — a render crash maps to
                UNKNOWN, so every error surface in the app says the same thing. */}
            <p className="text-gray-600 dark:text-gray-400 mb-2">{parseError(error).userMessage}</p>

            {/* Support join keys: the client-generated errorId (always) and the
                last GraphQL response's correlation id (when one exists) map a
                user-reported crash onto the gateway/server logs of the same
                session. This DISPLAYS reference codes; it does not claim the
                error was reported anywhere. */}
            {errorId && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                {labels.shareCode} <span className="font-mono break-all">{errorId}</span>
                {correlationId && (
                  <>
                    {' · '}
                    <span className="font-mono break-all">{correlationId}</span>
                  </>
                )}
              </p>
            )}

            {import.meta.env.DEV && error && (
              <div className="mb-6 p-4 bg-gray-100 dark:bg-gray-800 rounded-lg text-left">
                <p className="text-sm font-mono text-error-600 dark:text-error-400 break-all">
                  {error.message}
                </p>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Button variant="primary" onClick={this.handleRetry} disabled={retriesExhausted}>
                {labels.retry}
              </Button>
              <Button variant="outline" onClick={this.handleRefresh}>
                {labels.refresh}
              </Button>
              <Button variant="ghost" onClick={this.handleGoHome}>
                {labels.goHome}
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return children;
  }
}

/** Hook-side wrapper: resolves labels from the i18n SSOT and the retry-time
 * query-cache reset from the ambient QueryClientProvider. */
export const ErrorBoundary: React.FC<ErrorBoundaryProps> = (props) => {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const labels: ErrorBoundaryLabels = {
    titleWithModule: t('guards.title'),
    titleGeneric: t('guards.titleGeneric'),
    retry: t('common.retry'),
    refresh: t('guards.refresh'),
    goHome: t('guards.goHome'),
    shareCode: t('guards.shareCode'),
  };
  return (
    <ErrorBoundaryCore
      {...props}
      labels={labels}
      onResetQueries={() => {
        queryClient.resetQueries();
      }}
    />
  );
};
