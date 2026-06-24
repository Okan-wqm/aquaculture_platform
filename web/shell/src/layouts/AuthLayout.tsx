/**
 * Auth Layout Component
 *
 * Layout for login, register, and password reset pages.
 * Minimal, clean design.
 */

import React from 'react';
import { Outlet, Navigate } from 'react-router-dom';
import {
  BRAND,
  getAccessToken,
  tokenLifecycle,
  useAuthContext,
  useI18n,
  I18nProvider,
} from '@aquaculture/shared-ui';
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

  // The login/auth surface is presented in ENGLISH regardless of the app's
  // browser-detected locale — a nested provider overrides it for this subtree
  // only, so the rest of the app keeps its auto-detected language.
  return (
    <I18nProvider locale="en">
      <AuthChrome />
    </I18nProvider>
  );
};

// ============================================================================
// Auth chrome (inside the English i18n scope)
// ============================================================================

const AuthChrome: React.FC = () => {
  const { t } = useI18n();

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
        {/* Single top-level landmark heading for the auth routes (visually hidden;
            form headings are <h2>, giving a correct h1→h2 outline). */}
        <h1 className="sr-only">{BRAND.name}</h1>

        <div className="w-full max-w-md">
          {/* Card Container — glass surface SSoT (drives nested field/label/button
              colors via the shared-ui surface="glass" variant). The inner ring +
              soft ring-offset give the frosted card a crisp lit edge and depth. */}
          <div className="surface-glass backdrop-blur-md bg-white/65 border border-white/70 ring-1 ring-white/40 rounded-2xl shadow-2xl shadow-primary-900/20 p-6 sm:p-8 animate-fade-in">
            {/* Logo */}
            <div className="flex flex-col items-center mb-4">
              {/* logo4.png is true RGBA-transparent; logo.svg bakes in an
                  off-white (#F4F5F4) full-canvas background that shows as a white
                  box on the frosted card. Keep the responsive clamp() sizing. */}
              <img
                src="/logo4.png"
                alt={`${BRAND.name} logo`}
                className="object-contain drop-shadow-lg"
                style={{ width: 'clamp(8rem, 24vw, 16rem)', height: 'auto' }}
              />
              <p
                className="-mt-2 text-2xl text-center text-[var(--surface-heading-fg)]"
                style={{ fontFamily: "'Caveat', cursive" }}
              >
                {BRAND.tagline}
              </p>
            </div>

            {/* Form */}
            <Outlet />
          </div>

          {/* Footer Info */}
          <div className="mt-6 text-center text-sm text-white/70">
            <p>
              {t('auth.needHelp')}{' '}
              <a href={BRAND.supportUrl} className="text-white hover:underline font-medium">
                {t('auth.support')}
              </a>
            </p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 py-4 text-center text-sm text-white/60">
        <p>&copy; {CURRENT_YEAR} {BRAND.name}. {t('auth.allRightsReserved')}</p>
      </footer>
    </div>
  );
};

export default AuthLayout;
