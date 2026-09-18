import { Fish, Eye, EyeOff, AlertCircle, Waves, Fingerprint } from 'lucide-react';
import type { JSX } from 'react';
import { useState, useCallback, useEffect, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

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
    <div className="min-h-screen flex flex-col relative overflow-hidden bg-ocean-950">
      {/* Animated background gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-ocean-900 via-ocean-800 to-ocean-950" />

      {/* Decorative circles */}
      <div className="absolute -top-20 -right-20 w-64 h-64 rounded-full bg-ocean-600/20 blur-3xl" />
      <div className="absolute top-1/3 -left-16 w-48 h-48 rounded-full bg-sea-500/10 blur-3xl" />
      <div className="absolute bottom-20 right-10 w-56 h-56 rounded-full bg-ocean-500/10 blur-3xl" />

      {/* Wave pattern at bottom */}
      <div className="absolute bottom-0 left-0 right-0 opacity-10">
        <svg viewBox="0 0 1440 200" fill="none" className="w-full">
          <path
            d="M0,128L48,122.7C96,117,192,107,288,112C384,117,480,139,576,149.3C672,160,768,160,864,144C960,128,1056,96,1152,90.7C1248,85,1344,107,1392,117.3L1440,128V200H0Z"
            fill="currentColor"
            className="text-ocean-400"
          />
        </svg>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 relative z-10">
        {/* Logo area */}
        <div className="mb-10 flex flex-col items-center">
          <div className="w-20 h-20 bg-white/10 backdrop-blur-md rounded-2xl flex items-center justify-center mb-5 border border-white/20 shadow-glow-ocean">
            <Fish size={40} className="text-white" />
          </div>
          <h1 className="text-3xl font-bold text-white tracking-tight">AquaMobil</h1>
          <div className="flex items-center gap-2 mt-2">
            <Waves size={14} className="text-ocean-300" />
            <p className="text-ocean-300 text-sm font-medium">Field Operations</p>
            <Waves size={14} className="text-ocean-300" />
          </div>
        </div>

        {/* Login card */}
        <div className="w-full max-w-sm glass rounded-2xl shadow-elevated p-6">
          <div className="text-center mb-6">
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">Welcome back</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Sign in to continue</p>
          </div>

          {/* Mobile disabled message */}
          {isMobileDisabled && (
            <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl flex items-start gap-2">
              <AlertCircle size={18} className="text-amber-500 flex-shrink-0 mt-0.5" />
              <p className="text-amber-700 dark:text-amber-300 text-sm">
                Mobile access is not enabled for your account. Please contact your administrator.
              </p>
            </div>
          )}

          {/* Error message */}
          {error && !isMobileDisabled && (
            <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl flex items-center gap-2">
              <AlertCircle size={18} className="text-red-500 flex-shrink-0" />
              <p className="text-red-600 dark:text-red-300 text-sm">{error}</p>
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
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5"
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
                className="w-full px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-700 focus:border-ocean-500 focus:ring-2 focus:ring-ocean-500/20 outline-none transition-all bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder:text-gray-400"
              />
            </div>

            <div>
              <label
                htmlFor="login-password"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5"
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
                  className="w-full px-4 py-3 pr-12 rounded-xl border border-gray-200 dark:border-gray-700 focus:border-ocean-500 focus:ring-2 focus:ring-ocean-500/20 outline-none transition-all bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder:text-gray-400"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
                >
                  {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
            </div>


            <button
              type="submit"
              disabled={isLoading || isBiometricLoading}
              className="w-full py-3.5 px-4 bg-ocean-600 hover:bg-ocean-700 text-white font-semibold rounded-xl shadow-lg shadow-ocean-600/30 transition-all disabled:opacity-70 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <span className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
                  Signing in...
                </>
              ) : (
                'Sign In'
              )}
            </button>
          </form>

          {/* Biometric Login Button */}
          {biometricAvailable && (
            <div className="mt-4">
              <div className="relative flex items-center justify-center mb-4">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-200 dark:border-gray-700" />
                </div>
                <span className="relative bg-white dark:bg-gray-900 px-3 text-xs text-gray-400 uppercase tracking-wider">
                  or
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  void handleBiometricLogin();
                }}
                disabled={isLoading || isBiometricLoading}
                className="w-full py-3.5 px-4 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-750 border-2 border-ocean-500 text-ocean-600 dark:text-ocean-400 font-semibold rounded-xl shadow-sm transition-all disabled:opacity-70 disabled:cursor-not-allowed flex items-center justify-center gap-3"
              >
                {isBiometricLoading ? (
                  <>
                    <span className="animate-spin rounded-full h-5 w-5 border-2 border-ocean-500 border-t-transparent" />
                    Verifying...
                  </>
                ) : (
                  <>
                    <Fingerprint size={22} />
                    Biometric Login
                  </>
                )}
              </button>
            </div>
          )}

          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
            <p className="text-center text-xs text-gray-400">
              Contact your administrator if you need access.
            </p>
          </div>
        </div>

        <p className="mt-8 text-ocean-400/60 text-xs font-medium tracking-wider uppercase">
          v1.0.0
        </p>
      </div>
    </div>
  );
}
