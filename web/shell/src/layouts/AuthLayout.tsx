/**
 * Auth Layout Bileşeni
 *
 * Login, Register ve şifre sıfırlama sayfaları için layout.
 * Minimal, temiz tasarım.
 */

import React from 'react';
import { Outlet, Navigate } from 'react-router-dom';
import { useAuthContext } from '@aquaculture/shared-ui';

// ============================================================================
// Layout Bileşeni
// ============================================================================

const AuthLayout: React.FC = () => {
  const { isAuthenticated, isLoading } = useAuthContext();

  // Yüklenme durumu
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-600 to-secondary-600">
        <div className="animate-spin w-8 h-8 border-4 border-white border-t-transparent rounded-full" />
      </div>
    );
  }

  // Zaten giriş yapmış kullanıcıyı dashboard'a yönlendir
  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-600 to-secondary-600 flex flex-col">
      {/* Dekoratif arka plan elementleri */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-white/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-white/10 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-white/5 rounded-full blur-3xl" />
      </div>

      {/* Logo ve Başlık */}
      <header className="relative z-10 pt-8 pb-4 text-center">
        <div className="flex items-center justify-center space-x-3">
          {/* Logo */}
          <div className="w-12 h-12 bg-white rounded-xl flex items-center justify-center shadow-lg">
            <svg
              className="w-8 h-8 text-primary-600"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" />
              <path d="M8 12c0-2.21 1.79-4 4-4s4 1.79 4 4-1.79 4-4 4" />
              <path d="M12 8v8" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white">Aquaculture Platform</h1>
        </div>
        <p className="mt-2 text-sm text-white/80">
          Su Ürünleri Yetiştiriciliği Yönetim Sistemi
        </p>
      </header>

      {/* İçerik Alanı */}
      <main className="relative z-10 flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          {/* Card Container */}
          <div className="bg-white rounded-2xl shadow-2xl p-8 animate-fade-in">
            <Outlet />
          </div>

          {/* Alt Bilgi */}
          <div className="mt-6 text-center text-sm text-white/70">
            <p>
              Yardım mı lazım?{' '}
              <a href="/support" className="text-white hover:underline font-medium">
                Destek
              </a>
            </p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 py-4 text-center text-sm text-white/60">
        <p>&copy; {new Date().getFullYear()} Aquaculture Platform. Tüm hakları saklıdır.</p>
      </footer>
    </div>
  );
};

export default AuthLayout;
