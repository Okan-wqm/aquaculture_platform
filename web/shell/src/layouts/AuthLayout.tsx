/**
 * Auth Layout Component
 *
 * Layout for login, register, and password reset pages.
 * Minimal, clean design.
 */

import React from 'react';
import { Outlet, Navigate } from 'react-router-dom';
import { getAccessToken, tokenLifecycle, useAuthContext } from '@aquaculture/shared-ui';
import FishBackground from '../components/FishBackground';

const CURRENT_YEAR = new Date().getFullYear();

// ============================================================================
// Layout Component
// ============================================================================

const AuthLayout: React.FC = () => {
  const { isAuthenticated, isLoading, user } = useAuthContext();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-600 to-secondary-600">
        <div className="animate-spin w-8 h-8 border-4 border-white border-t-transparent rounded-full" />
      </div>
    );
  }

  const hasLiveSession =
    isAuthenticated &&
    !!user &&
    tokenLifecycle.getState() === 'READY' &&
    !!getAccessToken();

  // Redirect only when the React auth state and token lifecycle agree.
  if (hasLiveSession) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-600 to-secondary-600 flex flex-col">
      {/* Decorative background elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-white/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-white/10 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-white/5 rounded-full blur-3xl" />
      </div>

      {/* Animated fish background */}
      <FishBackground fishCount={14} />

      {/* Content area — logo and form combined */}
      <main className="relative z-10 flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          {/* Card Container — logo and form combined */}
          <div className="backdrop-blur-md bg-white/65 border border-white/70 rounded-2xl shadow-2xl p-8 animate-fade-in">
            {/* Logo */}
            <div className="flex flex-col items-center mb-4">
              <img
                src="/logo4.png"
                alt="Aquaculture Platform Logo"
                className="w-64 h-64 object-contain drop-shadow-lg"
              />
              <p className="-mt-2 text-2xl text-blue-700 text-center" style={{ fontFamily: "'Caveat', cursive" }}>
                Unlocks the power of farm management intelligence
              </p>
            </div>

            {/* Form */}
            <Outlet />
          </div>

          {/* Footer Info */}
          <div className="mt-6 text-center text-sm text-white/70">
            <p>
              Need help?{' '}
              <a href="/support" className="text-white hover:underline font-medium">
                Support
              </a>
            </p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 py-4 text-center text-sm text-white/60">
        <p>&copy; {CURRENT_YEAR} Aquaculture Platform. All rights reserved.</p>
      </footer>
    </div>
  );
};

export default AuthLayout;
