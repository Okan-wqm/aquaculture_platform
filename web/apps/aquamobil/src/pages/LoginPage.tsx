/**
 * LoginPage — the sign-in screen, converted to the v4 token layer.
 *
 * WHAT CHANGED: the page painted its own ocean-blue ground (a three-stop
 * gradient, three blue/green blobs and a blue wave) and then dropped a light
 * card on top of it. That card was written for the light theme, so on a
 * device in Day mode the app's first screen was the only dark one, and in Colour
 * mode it was the only screen that ignored the theme entirely.
 *
 * The glass treatment stays — it is what makes this screen feel like a door
 * rather than a form — but `.glass` is now token-driven (src/styles/main.css),
 * so it composes over whichever ground the active theme paints on <body>. The
 * decorative blobs and the wave keep their shape and take the accent's own dim
 * tint instead of a hardcoded blue, which is also what stops them from washing
 * out the card in Day.
 *
 * The WebAuthn/biometric path and the isMobileDisabled handling are untouched.
 */
import { Fish, Eye, EyeOff, AlertCircle, Waves, Fingerprint } from 'lucide-react';
import type { JSX } from 'react';
import { useState, useCallback, useEffect, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, IconButton } from '@/components/ui';
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

    // D07 VAL-01: Match the HTML minLength={8} attribute on the password input
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

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
    <div className="min-h-screen flex flex-col relative overflow-hidden">
      {/* Decorative haloes — shape unchanged, colour now the accent's own dim
          tint so they read as depth in every theme instead of as blue paint. */}
      <div className="absolute -top-20 -right-20 w-64 h-64 rounded-full bg-acc-dim blur-3xl" />
      <div className="absolute top-1/3 -left-16 w-48 h-48 rounded-full bg-acc-dim blur-3xl" />
      <div className="absolute bottom-20 right-10 w-56 h-56 rounded-full bg-acc-dim blur-3xl" />

      {/* Wave pattern at bottom */}
      <div className="absolute bottom-0 left-0 right-0 opacity-10">
        <svg viewBox="0 0 1440 200" fill="none" className="w-full" aria-hidden>
          <path
            d="M0,128L48,122.7C96,117,192,107,288,112C384,117,480,139,576,149.3C672,160,768,160,864,144C960,128,1056,96,1152,90.7C1248,85,1344,107,1392,117.3L1440,128V200H0Z"
            fill="currentColor"
            className="text-acc"
          />
        </svg>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 relative z-10">
        {/* Logo area */}
        <div className="mb-10 flex flex-col items-center">
          <div className="w-20 h-20 bg-surface-2 backdrop-blur-md rounded-2xl flex items-center justify-center mb-5 border border-line-strong shadow-acc">
            <Fish size={40} className="text-acc" aria-hidden />
          </div>
          <h1 className="text-display font-semibold text-ink-1">AquaMobil</h1>
          <div className="flex items-center gap-2 mt-2">
            <Waves size={14} className="text-acc" aria-hidden />
            <p className="text-body font-medium text-ink-2">Field Operations</p>
            <Waves size={14} className="text-acc" aria-hidden />
          </div>
        </div>

        {/* Login card */}
        <div className="w-full max-w-sm glass rounded-2xl shadow-token p-6">
          <div className="text-center mb-6">
            <h2 className="text-head font-semibold text-ink-1">Welcome back</h2>
            <p className="mt-1 text-body text-ink-2">Sign in to continue</p>
          </div>

          {/* Mobile disabled message */}
          {isMobileDisabled && (
            <div className="mb-4 p-3 bg-warn-dim border border-warn rounded-xl flex items-start gap-2">
              <AlertCircle size={18} className="text-warn flex-shrink-0 mt-0.5" aria-hidden />
              <p className="text-body text-warn">
                Mobile access is not enabled for your account. Please contact your administrator.
              </p>
            </div>
          )}

          {/* Error message — announced, because a sighted user sees it appear
              and a screen-reader user otherwise gets silence after Sign In. */}
          {error && !isMobileDisabled && (
            <div
              role="alert"
              className="mb-4 p-3 bg-crit-dim border border-crit rounded-xl flex items-center gap-2"
            >
              <AlertCircle size={18} className="text-crit flex-shrink-0" aria-hidden />
              <p className="text-body text-crit">{error}</p>
            </div>
          )}

          {/* Login form */}
          <form
            method="post"
            autoComplete="off"
            onSubmit={(e) => {
              void handleSubmit(e);
            }}
            className="space-y-4"
          >
            <div>
              <label
                htmlFor="login-email"
                className="block text-body font-medium text-ink-2 mb-1.5"
              >
                Email
              </label>
              {/* The focus ring on both inputs is owned by the global
                  `input:focus` rule in src/styles/main.css, which paints it with
                  the accent token — hence no focus:* classes here. */}
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={handleEmailChange}
                placeholder="name@company.com"
                autoComplete="username"
                autoCapitalize="none"
                required
                className="w-full px-4 py-3 rounded-xl border border-line bg-surface-2 text-ink-1 placeholder:text-ink-3 outline-none transition-all"
              />
            </div>

            <div>
              <label
                htmlFor="login-password"
                className="block text-body font-medium text-ink-2 mb-1.5"
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
                  minLength={8}
                  maxLength={128}
                  required
                  className="w-full px-4 py-3 pr-12 rounded-xl border border-line bg-surface-2 text-ink-1 placeholder:text-ink-3 outline-none transition-all"
                />
                {/* Was a ~28px icon-only <button> with no accessible name.
                    IconButton bakes the 44px floor in and requires the label. */}
                <IconButton
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 text-ink-3"
                >
                  {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                </IconButton>
              </div>
            </div>

            <Button
              type="submit"
              variant="primary"
              size="save"
              block
              disabled={isLoading || isBiometricLoading}
            >
              {isLoading ? (
                <>
                  <span className="animate-spin rounded-full h-5 w-5 border-2 border-current border-t-transparent" />
                  Signing in...
                </>
              ) : (
                'Sign In'
              )}
            </Button>
          </form>

          {/* Biometric Login Button */}
          {biometricAvailable && (
            <div className="mt-4">
              <div className="relative flex items-center justify-center mb-4">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-line" />
                </div>
                <span className="relative bg-surface-1 px-3 text-meta text-ink-3">or</span>
              </div>
              {/* The outlined accent treatment stays: biometric is a real
                  alternative to the password, not the primary path. */}
              <Button
                variant="secondary"
                size="save"
                block
                className="border border-acc text-acc"
                onClick={() => {
                  void handleBiometricLogin();
                }}
                disabled={isLoading || isBiometricLoading}
              >
                {isBiometricLoading ? (
                  <>
                    <span className="animate-spin rounded-full h-5 w-5 border-2 border-current border-t-transparent" />
                    Verifying...
                  </>
                ) : (
                  <>
                    <Fingerprint size={22} aria-hidden />
                    Biometric Login
                  </>
                )}
              </Button>
            </div>
          )}

          <div className="mt-4 pt-4 border-t border-line">
            <p className="text-center text-meta text-ink-3">
              Contact your administrator if you need access.
            </p>
          </div>
        </div>

        {/* The build's version string — a machine value, so it is set in mono. */}
        <p className="mt-8 text-meta font-mono text-ink-3">v1.0.0</p>
      </div>
    </div>
  );
}
