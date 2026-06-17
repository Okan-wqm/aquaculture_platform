/**
 * SchedulingErrorBoundary Component
 * Error boundary specific to scheduling module with Turkish localization
 */

import React, { Component, ErrorInfo } from 'react';
import { AlertTriangle, RefreshCw, Home, ArrowLeft } from 'lucide-react';
import { cn } from '@aquaculture/shared-ui';

interface SchedulingErrorBoundaryProps {
  children: React.ReactNode;
  onRetry?: () => void;
  fallbackComponent?: React.ReactNode;
}

interface SchedulingErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class SchedulingErrorBoundary extends Component<
  SchedulingErrorBoundaryProps,
  SchedulingErrorBoundaryState
> {
  constructor(props: SchedulingErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<SchedulingErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });

    // Log error for monitoring
    console.error('[SchedulingErrorBoundary] Caught error:', {
      error: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    });

    // In production, send to error tracking service
    if (import.meta.env.PROD) {
      // TODO: Integrate with Sentry or similar
    }
  }

  handleRetry = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
    this.props.onRetry?.();
  };

  handleRefresh = (): void => {
    window.location.reload();
  };

  handleGoBack = (): void => {
    window.history.back();
  };

  handleGoHome = (): void => {
    window.location.href = '/hr';
  };

  render(): React.ReactNode {
    const { hasError, error } = this.state;
    const { children, fallbackComponent } = this.props;

    if (hasError) {
      if (fallbackComponent) {
        return fallbackComponent;
      }

      return (
        <div
          className="min-h-[400px] flex items-center justify-center p-8"
          role="alert"
          aria-live="assertive"
        >
          <div className="text-center max-w-lg">
            {/* Error Icon */}
            <div className="mx-auto w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mb-6">
              <AlertTriangle className="w-8 h-8 text-red-600" aria-hidden="true" />
            </div>

            {/* Title */}
            <h2 className="text-xl font-semibold text-gray-900 mb-3">
              Cizelge Modulu Yüklenemedi
            </h2>

            {/* Description */}
            <p className="text-gray-600 mb-6">
              Haftalik is cizelgesi yuklenirken beklenmeyen bir hata olustu.
              Lutfen sayfayi yenileyin veya daha sonra tekrar deneyin.
            </p>

            {/* Error details in development */}
            {import.meta.env.DEV && error && (
              <div className="mb-6 p-4 bg-gray-100 rounded-lg text-left overflow-auto max-h-48">
                <p className="text-xs font-mono text-gray-500 mb-1">Hata Detayi:</p>
                <p className="text-sm font-mono text-red-600 break-all">
                  {error.message}
                </p>
                {error.stack && (
                  <pre className="text-xs font-mono text-gray-400 mt-2 whitespace-pre-wrap">
                    {error.stack.split('\n').slice(1, 5).join('\n')}
                  </pre>
                )}
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex flex-wrap gap-3 justify-center">
              <button
                onClick={this.handleRetry}
                className={cn(
                  'inline-flex items-center gap-2 px-4 py-2',
                  'bg-indigo-600 text-white rounded-lg',
                  'hover:bg-indigo-700 transition-colors',
                  'focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2'
                )}
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Tekrar Dene
              </button>

              <button
                onClick={this.handleRefresh}
                className={cn(
                  'inline-flex items-center gap-2 px-4 py-2',
                  'bg-white text-gray-700 border border-gray-300 rounded-lg',
                  'hover:bg-gray-50 transition-colors',
                  'focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2'
                )}
              >
                Sayfayi Yenile
              </button>

              <button
                onClick={this.handleGoBack}
                className={cn(
                  'inline-flex items-center gap-2 px-4 py-2',
                  'text-gray-600 hover:text-gray-800 transition-colors',
                  'focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 rounded-lg'
                )}
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Geri Don
              </button>

              <button
                onClick={this.handleGoHome}
                className={cn(
                  'inline-flex items-center gap-2 px-4 py-2',
                  'text-gray-600 hover:text-gray-800 transition-colors',
                  'focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 rounded-lg'
                )}
              >
                <Home className="h-4 w-4" aria-hidden="true" />
                HR Ana Sayfa
              </button>
            </div>

            {/* Help text */}
            <p className="text-sm text-gray-400 mt-8">
              Sorun devam ederse sistem yoneticisi ile iletisime gecin.
            </p>
          </div>
        </div>
      );
    }

    return children;
  }
}

export default SchedulingErrorBoundary;
