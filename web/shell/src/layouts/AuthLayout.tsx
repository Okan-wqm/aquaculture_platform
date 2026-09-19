/**
 * Auth Layout Component
 *
 * Industrial reef layout for login, invitation, and password reset pages.
 * Authentication behavior remains owned by AuthContext and the routed forms.
 */

import React from 'react';
import { Outlet, Navigate } from 'react-router-dom';
import {
  BRAND,
  getAccessToken,
  tokenLifecycle,
  useAuthContext,
  useI18n,
  Spinner,
} from '@aquaculture/shared-ui';
import FishBackground from '../components/FishBackground';
import { Lock } from 'lucide-react';

const CURRENT_YEAR = new Date().getFullYear();

const SecureLockIcon: React.FC = () => <Lock aria-hidden="true" size={12} />;

// ============================================================================
// Layout Component
// ============================================================================

const AuthLayout: React.FC = () => {
  const { isAuthenticated, isLoading, user } = useAuthContext();

  if (isLoading) {
    return (
      <div className="industrial-auth-loading min-h-screen flex items-center justify-center">
        <div role="status" aria-label="Loading authentication">
          <Spinner size="lg" color="inherit" className="text-primary-300" />
        </div>
      </div>
    );
  }

  const hasLiveSession =
    isAuthenticated && !!user && tokenLifecycle.getState() === 'READY' && !!getAccessToken();

  // Redirect only when the React auth state and token lifecycle agree.
  if (hasLiveSession) {
    return <Navigate to="/" replace />;
  }

  // The auth surface speaks the same language as the rest of the shell — the
  // device preference, then the browser, then Turkish (FE-HIGH-089). It used to
  // pin English here while <html lang> said Turkish.
  return <AuthChrome />;
};

// ============================================================================
// Auth chrome (inside the English i18n scope)
// ============================================================================

const AuthChrome: React.FC = () => {
  const { t } = useI18n();

  return (
    <div className="industrial-auth">
      <FishBackground fishCount={20} />

      <main className="industrial-auth-main">
        {/* Single top-level landmark heading for the auth routes (visually hidden;
            form headings are <h2>, giving a correct h1→h2 outline). */}
        <h1 className="sr-only">{BRAND.name}</h1>

        <section
          className="industrial-auth-card surface-glass"
          aria-label={`${BRAND.name} authentication`}
        >
          <div className="industrial-auth-card-highlight" />
          <div className="industrial-auth-card-glow" />

          <div className="industrial-auth-card-header">
            <div className="industrial-auth-security-chip" aria-label={t('auth.authorizedAccess')}>
              <span className="industrial-auth-security-dot" />
              access
            </div>

            <div className="industrial-auth-brand">
              <img src="/logo4.png" alt={`${BRAND.name} logo`} className="industrial-auth-logo" />
              <p className="industrial-auth-tagline">{BRAND.tagline}</p>
            </div>
          </div>

          <div className="industrial-auth-card-body">
            <Outlet />
          </div>

          <div className="industrial-auth-card-security">
            <SecureLockIcon />
            <span>{t('auth.authorizedAccess')}</span>
          </div>
        </section>
      </main>

      <footer className="industrial-auth-footer">
        <span>
          &copy; {CURRENT_YEAR} {BRAND.name}
        </span>
        <a href={BRAND.supportUrl}>{t('auth.support')}</a>
      </footer>
    </div>
  );
};

export default AuthLayout;
