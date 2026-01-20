/**
 * Error Boundary Bileşeni
 *
 * React hata sınırı - Microfrontend modüllerindeki
 * hataları yakalayıp kullanıcı dostu mesaj gösterir.
 */

import React, { Component, ErrorInfo } from 'react';
import { Button } from '@aquaculture/shared-ui';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

interface ErrorBoundaryProps {
  /** Alt bileşenler */
  children: React.ReactNode;
  /** Modül adı (hata mesajında gösterilir) */
  moduleName?: string;
  /** Özel fallback bileşeni */
  fallback?: React.ReactNode;
  /** Hata callback'i */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  /** Hata oluştu mu */
  hasError: boolean;
  /** Hata detayı */
  error: Error | null;
  /** Hata bilgisi */
  errorInfo: ErrorInfo | null;
}

// ============================================================================
// Error Boundary Bileşeni
// ============================================================================

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  /**
   * Hata yakalandığında state güncelle
   */
  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  /**
   * Hata bilgisini logla
   */
  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });

    // Callback varsa çağır
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }

    // Hata loglama servisi (production'da)
    if (import.meta.env.PROD) {
      // TODO: Sentry veya benzeri servise gönder
      console.error('Module Error:', {
        module: this.props.moduleName,
        error: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
      });
    } else {
      console.error('Module Error:', error, errorInfo);
    }
  }

  /**
   * Sayfayı yenile
   */
  handleRefresh = (): void => {
    window.location.reload();
  };

  /**
   * Tekrar dene (state sıfırla)
   */
  handleRetry = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  /**
   * Ana sayfaya dön
   */
  handleGoHome = (): void => {
    window.location.href = '/';
  };

  render(): React.ReactNode {
    const { hasError, error } = this.state;
    const { children, moduleName, fallback } = this.props;

    if (hasError) {
      // Özel fallback varsa göster
      if (fallback) {
        return fallback;
      }

      // Varsayılan hata ekranı
      return (
        <div className="min-h-[400px] flex items-center justify-center p-8">
          <div className="text-center max-w-md">
            {/* Hata ikonu */}
            <div className="mx-auto w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mb-4">
              <svg
                className="w-8 h-8 text-red-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>

            {/* Başlık */}
            <h2 className="text-xl font-semibold text-gray-900 mb-2">
              {moduleName ? `${moduleName} Modülü Yüklenemedi` : 'Bir Hata Oluştu'}
            </h2>

            {/* Açıklama */}
            <p className="text-gray-600 mb-6">
              Beklenmeyen bir hata oluştu. Lütfen sayfayı yenileyin veya daha sonra tekrar deneyin.
            </p>

            {/* Hata detayı (development'ta) */}
            {import.meta.env.DEV && error && (
              <div className="mb-6 p-4 bg-gray-100 rounded-lg text-left">
                <p className="text-sm font-mono text-red-600 break-all">
                  {error.message}
                </p>
              </div>
            )}

            {/* Aksiyon butonları */}
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Button variant="primary" onClick={this.handleRetry}>
                Tekrar Dene
              </Button>
              <Button variant="outline" onClick={this.handleRefresh}>
                Sayfayı Yenile
              </Button>
              <Button variant="ghost" onClick={this.handleGoHome}>
                Ana Sayfaya Dön
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return children;
  }
}

export default ErrorBoundary;
