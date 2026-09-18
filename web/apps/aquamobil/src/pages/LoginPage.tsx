/**
 * LoginPage — a MINIATURE of the web (shell) sign-in screen.
 *
 * DESIGN CONTRACT (2026-09-17): this screen mirrors
 * web/shell/src/layouts/AuthLayout.tsx — the industrial-auth composition —
 * scaled down for a phone: the same deep-ocean gradient ground with teal
 * radial glows, the same frosted glass card (translucent #f0f6f7, white
 * hairline border, top highlight), the SUDERRA lockup + Caveat tagline,
 * translucent ink fields and the #4fb6c8 action button. The web page is the
 * SSoT for this look; change it there first, then mirror here.
 *
 * Brand identity (name/tagline/logo assets) comes from the shared-ui BRAND
 * SSoT via the @aquaculture/shared-ui/brand alias — not a local copy.
 *
 * The WebAuthn/biometric path and the isMobileDisabled handling are untouched.
 * NOTE: no client-side password length gate — the auth server owns that
 * contract (see handleSubmit).
 */
import { Eye, EyeOff, AlertCircle, Fingerprint, Lock } from 'lucide-react';
import type { JSX } from 'react';
import { useState, useCallback, useEffect, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { IconButton } from '@/components/ui';
import { BRAND } from '@aquaculture/shared-ui/brand';
import { BOARD_MEDIA_QUERY, useMediaQuery } from '@/hooks/useViewport';
import lockupUrl from '@/assets/suderra-lockup.png';
import { useAuth } from '@/hooks/useAuth';
import {
  isWebAuthnSupported,
  hasLocalCredentials,
  getStoredBiometricEmail,
  storeBiometricEmail,
  useWebAuthn,
} from '@/hooks/useWebAuthn';

export function LoginPage(): JSX.Element | null {
  const navigate = useNavigate();
  const { login, loginWithToken, isLoading, isAuthenticated, isMobileDisabled } = useAuth();
  // SSoT: the biometric login flow (challenge → WebAuthn assertion → verify) lives
  // in useWebAuthn.biometricLogin. The page consumes it rather than re-implementing
  // the GraphQL round-trips and base64url helpers, so the typed { accessToken, user }
  // result flows straight into loginWithToken with no `any` boundary.
  const { biometricLogin, isLoggingIn: isBiometricLoading } = useWebAuthn();
  // Tablet/phone scale split (same viewport seam the app shell uses — the
  // media-query hook is the sanctioned export for second consumers). The
  // DESIGN stays the web-login miniature on both; only the scale changes so
  // a cabin tablet doesn't get a phone-sized card on a wall screen.
  const isTablet = useMediaQuery(BOARD_MEDIA_QUERY);
  const scale = isTablet
    ? { card: 440, radius: 28, lockup: 160, padX: 40, tagline: 18, title: 22 }
    : { card: 360, radius: 24, lockup: 116, padX: 28, tagline: 16, title: 19 };

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  // SEC-10: "Remember Me" checkbox removed — session persistence is handled by
  // the httpOnly refresh token cookie set by the backend. There is no separate
  // "remember" vs "forget" mode in the current auth architecture.

  // Check biometric availability on mount. Synchronous browser/local checks only,
  // so the effect callback needs no async/await.
  useEffect(() => {
    if (isWebAuthnSupported() && hasLocalCredentials()) {
      setBiometricAvailable(true);
      // Pre-fill email from stored biometric email
      const storedEmail = getStoredBiometricEmail();
      if (storedEmail) {
        setEmail((current) => current || storedEmail);
      }
    }
  }, []);

  const handleEmailChange = useCallback((e: ChangeEvent<HTMLInputElement>): void => {
    setEmail(e.target.value);
    setError('');
  }, []);

  const handlePasswordChange = useCallback((e: ChangeEvent<HTMLInputElement>): void => {
    setPassword(e.target.value);
    setError('');
  }, []);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError('');

    if (!email || !password) {
      setError('Please enter email and password');
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setError('Please enter a valid email address');
      return;
    }

    // NOTE (2026-09-17): no client-side length gate on LOGIN. The 8-char
    // minimum is the SET-password policy (auth-service reset/change DTOs);
    // the login contract itself has no minimum, and legacy accounts carry
    // shorter credentials. The server is the SSoT here — inventing a local
    // minimum locked real users out (6-char test account).

    try {
      await login(email, password);
      // Store email for future biometric login
      if (email) storeBiometricEmail(email);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    }
  };

  const handleBiometricLogin = async (): Promise<void> => {
    const biometricEmail = email || getStoredBiometricEmail();
    if (!biometricEmail) {
      setError('Please enter your email address first');
      return;
    }

    setError('');

    // SSoT: useWebAuthn.biometricLogin runs the full challenge/verify round-trip and
    // returns a typed { accessToken, user } or null (it surfaces its own sanitized
    // error via the hook). null means cancelled/failed — keep the form interactive.
    const result = await biometricLogin(biometricEmail);
    if (!result) {
      return;
    }

    try {
      // Complete login using the token received from WebAuthn verification.
      // The httpOnly refresh token cookie has already been set by the backend.
      await loginWithToken(result.accessToken, result.user);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Biometric login failed');
    }
  };

  if (isAuthenticated) {
    navigate('/', { replace: true });
    return null;
  }

  return (
    <div
      className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4 py-8"
      style={{
        // Mirror of the shell's .industrial-auth ground (AuthLayout SSoT).
        background:
          'radial-gradient(ellipse 80% 50% at 50% -10%, rgb(127 214 224 / 0.18), transparent 60%),'
          + 'radial-gradient(ellipse 60% 40% at 50% 5%, rgb(200 240 238 / 0.1), transparent 70%),'
          + 'linear-gradient(180deg, #0b324a 0%, #0a2b40 18%, #061b2c 40%, #04111c 70%, #020a12 100%)',
        fontFamily: "'Geist', 'Inter', ui-sans-serif, system-ui, sans-serif",
      }}
    >
      {/* Glass card — miniature of .industrial-auth-card */}
      <div
        className="relative w-full overflow-hidden"
        style={{
          maxWidth: scale.card,
          border: '1px solid rgb(255 255 255 / 0.55)',
          borderRadius: scale.radius,
          background: 'rgb(240 246 247 / 0.58)',
          boxShadow:
            '0 24px 80px -20px rgb(0 0 0 / 0.65), 0 8px 24px -8px rgb(0 30 50 / 0.5),'
            + ' inset 0 1px 0 rgb(255 255 255 / 0.06)',
          backdropFilter: 'blur(10px) saturate(130%)',
          WebkitBackdropFilter: 'blur(10px) saturate(130%)',
        }}
      >
        {/* Top highlight — .industrial-auth-card-highlight */}
        <div
          style={{
            position: 'absolute', top: 0, right: 0, left: 0, height: 1, zIndex: 1,
            background:
              'linear-gradient(90deg, transparent, rgb(255 255 255 / 0.35), transparent)',
            pointerEvents: 'none',
          }}
        />

        {/* Security chip — .industrial-auth-security-chip */}
        <div
          className="absolute flex items-center gap-1.5"
          style={{
            top: 12, right: 12, padding: '4px 9px',
            border: '1px solid rgb(20 58 92 / 0.12)', borderRadius: 999,
            background: 'rgb(255 255 255 / 0.4)',
            color: '#294e65', fontSize: 12, fontWeight: 600,
            letterSpacing: '0.08em', textTransform: 'uppercase',
          }}
        >
          <span
            style={{
              width: 6, height: 6, borderRadius: 999,
              background: '#2f8ca0', boxShadow: '0 0 6px rgb(47 140 160 / 0.8)',
            }}
          />
          Secure
        </div>

        {/* Card header: brand — .industrial-auth-card-header/.industrial-auth-brand */}
        <div className="flex flex-col items-center pt-8 pb-2" style={{ paddingLeft: scale.padX, paddingRight: scale.padX }}>
          <img
            src={lockupUrl}
            alt={`${BRAND.name} logo`}
            style={{
              width: scale.lockup, height: 'auto', objectFit: 'contain',
              filter: 'drop-shadow(0 8px 14px rgb(2 30 45 / 0.14))',
            }}
          />
          <p
            style={{
              margin: '6px 0 0', maxWidth: 300, textAlign: 'center',
              color: '#1c3b66', fontFamily: "'Caveat', cursive",
              fontSize: scale.tagline, fontWeight: 500, lineHeight: 1.25,
            }}
          >
            {BRAND.tagline}
          </p>
        </div>

        {/* Card body — .industrial-auth-card-body */}
        <div className="pb-6" style={{ paddingLeft: scale.padX, paddingRight: scale.padX }}>
          <div className="mb-5 text-center">
            <h1 className="font-bold" style={{ color: '#14304a', fontSize: scale.title }}>
              Welcome back
            </h1>
            <p className="mt-0.5 text-[13px]" style={{ color: '#294e65' }}>
              Sign in to continue
            </p>
          </div>

          {/* Mobile disabled message */}
          {isMobileDisabled && (
            <div
              className="mb-4 flex items-start gap-2 rounded-xl p-3"
              style={{ background: 'rgb(200 154 60 / 0.14)', border: '1px solid rgb(200 154 60 / 0.5)' }}
            >
              <AlertCircle size={18} className="mt-0.5 flex-shrink-0" style={{ color: '#92610a' }} aria-hidden />
              <p className="text-[13px]" style={{ color: '#92610a' }}>
                Mobile access is not enabled for your account. Please contact your administrator.
              </p>
            </div>
          )}

          {/* Error message — announced for screen readers */}
          {error && !isMobileDisabled && (
            <div
              role="alert"
              className="mb-4 flex items-center gap-2 rounded-xl p-3"
              style={{ background: 'rgb(176 74 40 / 0.1)', border: '1px solid rgb(176 74 40 / 0.4)' }}
            >
              <AlertCircle size={18} className="flex-shrink-0" style={{ color: '#b04a28' }} aria-hidden />
              <p className="text-[13px]" style={{ color: '#8e3a1e' }}>
                {error}
              </p>
            </div>
          )}

          {/* Login form — translucent ink fields (.surface-field-*) */}
          <form
            method="post"
            autoComplete="off"
            onSubmit={(e) => {
              void handleSubmit(e);
            }}
            className="space-y-3.5"
          >
            <div>
              <label
                htmlFor="login-email"
                className="mb-1 block text-[13px] font-semibold"
                style={{ color: '#217a8e' }}
              >
                Email
              </label>
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={handleEmailChange}
                placeholder="name@company.com"
                autoComplete="username"
                autoCapitalize="none"
                required
                className="w-full rounded-xl px-3.5 py-3 text-[15px] outline-none transition-all placeholder:opacity-60"
                style={{
                  background: 'rgb(255 255 255 / 0.52)',
                  color: '#14304a',
                  border: '1px solid rgb(20 58 92 / 0.22)',
                }}
              />
            </div>

            <div>
              <label
                htmlFor="login-password"
                className="mb-1 block text-[13px] font-semibold"
                style={{ color: '#217a8e' }}
              >
                Password
              </label>
              <div className="relative">
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={handlePasswordChange}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  maxLength={128}
                  required
                  className="w-full rounded-xl px-3.5 py-3 pr-12 text-[15px] outline-none transition-all placeholder:opacity-60"
                  style={{
                    background: 'rgb(255 255 255 / 0.52)',
                    color: '#14304a',
                    border: '1px solid rgb(20 58 92 / 0.22)',
                  }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = 'rgb(47 140 160 / 0.6)')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = 'rgb(20 58 92 / 0.22)')}
                />
                <IconButton
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                  style={{ color: '#294e65' }}
                >
                  {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                </IconButton>
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading || isBiometricLoading}
              className="mt-1 w-full rounded-xl py-3 text-[15px] font-bold transition-all active:scale-[0.99] disabled:opacity-60"
              style={{
                background: '#4fb6c8',
                color: '#04222a',
                border: '1px solid rgb(143 220 230 / 0.8)',
                boxShadow: '0 8px 20px -8px rgb(79 182 200 / 0.55)',
              }}
            >
              {isLoading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Signing in...
                </span>
              ) : (
                'Sign In'
              )}
            </button>
          </form>

          {/* Biometric Login — same outlined alternative as the web flow */}
          {biometricAvailable && (
            <div className="mt-4">
              <div className="relative mb-3 flex items-center justify-center">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t" style={{ borderColor: 'rgb(20 58 92 / 0.14)' }} />
                </div>
                <span
                  className="relative px-3 text-[12px]"
                  style={{ background: 'rgb(240 246 247 / 0)', color: '#294e65' }}
                >
                  or
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  void handleBiometricLogin();
                }}
                disabled={isLoading || isBiometricLoading}
                className="flex w-full items-center justify-center gap-2 rounded-xl py-3 text-[15px] font-semibold transition-all disabled:opacity-60"
                style={{
                  background: 'rgb(255 255 255 / 0.4)',
                  color: '#217a8e',
                  border: '1px solid rgb(47 140 160 / 0.45)',
                }}
              >
                {isBiometricLoading ? (
                  <>
                    <span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    Verifying...
                  </>
                ) : (
                  <>
                    <Fingerprint size={20} aria-hidden />
                    Biometric Login
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        {/* Security footer — .industrial-auth-card-security */}
        <div
          className="flex items-center justify-center gap-1.5 py-3"
          style={{
            paddingLeft: scale.padX,
            paddingRight: scale.padX,
            borderTop: '1px solid rgb(20 58 92 / 0.1)',
            color: '#294e65',
          }}
        >
          <Lock size={12} aria-hidden />
          <span className="text-[12px]">
            Protected session &middot; {BRAND.name} field access
          </span>
        </div>
      </div>

      {/* Version string — machine value in mono */}
      <p
        className="mt-6 font-mono text-[12px]"
        style={{ color: 'rgb(234 246 249 / 0.5)' }}
      >
        v1.0.0
      </p>
    </div>
  );
}