/**
 * Login form + MFA challenge screen.
 *
 * Uses the glass-surface design tokens (no raw blue or white utilities), the
 * i18n SSoT, the shared PasswordInput (show/hide + caps-lock), and binds a REAL
 * "remember me"
 * checkbox that threads through to login() (ORPHAN-LOW-135).
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Button,
  Input,
  PasswordInput,
  Checkbox,
  useAuthContext,
  useI18n,
  required,
  email as emailValidator,
  minLength,
  validateField,
  validateNavigationUrl,
} from '@aquaculture/shared-ui';
import type { MfaChallengeResult } from '@aquaculture/shared-ui';

import { AuthFormShell } from './AuthFormShell';

const LockIcon: React.FC = () => (
  <svg
    className="w-6 h-6"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={1.7}
    aria-hidden="true"
  >
    <path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3Z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

const EmailIcon: React.FC = () => (
  <svg
    className="w-full h-full"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    aria-hidden="true"
  >
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3 7 9 6 9-6" />
  </svg>
);

const PasswordIcon: React.FC = () => (
  <svg
    className="w-full h-full"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    aria-hidden="true"
  >
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 018 0v3" />
  </svg>
);

const ArrowRightIcon: React.FC = () => (
  <svg
    className="w-4 h-4"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    aria-hidden="true"
  >
    <path d="M5 12h14M13 5l7 7-7 7" />
  </svg>
);

const LoginForm: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { login, verifyMfaLogin, error: authError, clearError } = useAuthContext();

  const [formData, setFormData] = useState({ email: '', password: '', rememberMe: false });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // MFA challenge state
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallengeResult | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaError, setMfaError] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const mfaInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mfaChallenge && mfaInputRef.current) {
      mfaInputRef.current.focus();
    }
  }, [mfaChallenge, useRecoveryCode]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const { name, value } = e.target;
      setFormData((prev) => ({ ...prev, [name]: value }));
      setErrors((prev) => ({ ...prev, [name]: '' }));
      clearError();
    },
    [clearError],
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      const newErrors: Record<string, string> = {};
      const emailResult = validateField(formData.email, [required(), emailValidator()]);
      if (!emailResult.valid) newErrors.email = emailResult.error || '';
      const passwordResult = validateField(formData.password, [required(), minLength(6)]);
      if (!passwordResult.valid) newErrors.password = passwordResult.error || '';

      if (Object.keys(newErrors).length > 0) {
        setErrors(newErrors);
        return;
      }

      setIsSubmitting(true);
      try {
        const result = await login({
          email: formData.email,
          password: formData.password,
          rememberMe: formData.rememberMe,
        });

        if ('mfaRequired' in result && result.mfaRequired) {
          setMfaChallenge(result as MfaChallengeResult);
          setMfaCode('');
          setMfaError('');
          setUseRecoveryCode(false);
          return;
        }

        const redirectPath = (result as { redirectPath: string }).redirectPath;
        const validatedPath = validateNavigationUrl(redirectPath);
        const safePath = validatedPath?.startsWith('/') ? validatedPath : '/';
        navigate(safePath);
      } catch {
        // Auth context handles error display
      } finally {
        setIsSubmitting(false);
      }
    },
    [formData, login, navigate],
  );

  const handleMfaSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!mfaChallenge) return;

      const code = mfaCode.trim();
      if (!code) {
        setMfaError(
          useRecoveryCode ? t('login.mfa.recoveryRequired') : t('login.mfa.codeRequired'),
        );
        return;
      }
      if (!useRecoveryCode && !/^\d{6}$/.test(code)) {
        setMfaError(t('login.mfa.invalidCode'));
        return;
      }
      if (useRecoveryCode && (code.length < 6 || code.length > 12)) {
        setMfaError(t('login.mfa.invalidRecovery'));
        return;
      }

      setIsSubmitting(true);
      setMfaError('');
      try {
        const { redirectPath } = await verifyMfaLogin({ mfaToken: mfaChallenge.mfaToken, code });
        const validatedPath = validateNavigationUrl(redirectPath);
        const safePath = validatedPath?.startsWith('/') ? validatedPath : '/';
        navigate(safePath);
      } catch (err) {
        const message = err instanceof Error ? err.message : t('common.error');
        setMfaError(message);
        setMfaCode('');
        clearError();
      } finally {
        setIsSubmitting(false);
      }
    },
    [mfaChallenge, mfaCode, useRecoveryCode, verifyMfaLogin, navigate, clearError, t],
  );

  const handleBackToLogin = useCallback(() => {
    setMfaChallenge(null);
    setMfaCode('');
    setMfaError('');
    setUseRecoveryCode(false);
    clearError();
  }, [clearError]);

  const normalizedMfaCode = mfaCode.trim();
  const isMfaCodeReady = useRecoveryCode
    ? normalizedMfaCode.length >= 6 && normalizedMfaCode.length <= 12
    : /^\d{6}$/.test(normalizedMfaCode);

  // ── MFA Challenge Screen ──────────────────────────────────────────────────
  if (mfaChallenge) {
    return (
      <AuthFormShell
        titleKey="login.mfa.title"
        subtitleKey={useRecoveryCode ? 'login.mfa.recoveryPrompt' : 'login.mfa.totpPrompt'}
        icon={<LockIcon />}
        error={mfaError || authError}
        onDismissError={() => {
          setMfaError('');
          clearError();
        }}
      >
        <form onSubmit={handleMfaSubmit} className="industrial-login-form industrial-mfa-form">
          {useRecoveryCode ? (
            <Input
              ref={mfaInputRef}
              surface="glass"
              className="industrial-auth-field industrial-mfa-field"
              label={t('login.mfa.verifyRecovery')}
              type="text"
              name="recoveryCode"
              value={mfaCode}
              onChange={(e) => {
                setMfaCode(e.target.value);
                setMfaError('');
              }}
              autoComplete="off"
              required
            />
          ) : (
            <Input
              ref={mfaInputRef}
              surface="glass"
              className="industrial-auth-field industrial-mfa-field"
              label={t('login.mfa.verifyCode')}
              type="text"
              inputMode="numeric"
              name="mfaCode"
              value={mfaCode}
              onChange={(e) => {
                const val = e.target.value.replace(/\D/g, '').slice(0, 6);
                setMfaCode(val);
                setMfaError('');
              }}
              placeholder="000000"
              maxLength={6}
              autoComplete="one-time-code"
              required
            />
          )}

          <Button
            surface="glass"
            type="submit"
            size="lg"
            fullWidth
            loading={isSubmitting}
            disabled={!isMfaCodeReady}
            className="industrial-auth-submit"
          >
            {useRecoveryCode ? t('login.mfa.verifyRecovery') : t('login.mfa.verifyCode')}
          </Button>

          <div className="industrial-mfa-actions">
            <button
              type="button"
              onClick={() => {
                setUseRecoveryCode(!useRecoveryCode);
                setMfaCode('');
                setMfaError('');
              }}
              className="industrial-auth-link"
            >
              {useRecoveryCode ? t('login.mfa.useAuthenticator') : t('login.mfa.useRecovery')}
            </button>
            <button type="button" onClick={handleBackToLogin} className="industrial-auth-link">
              {t('login.mfa.backToLogin')}
            </button>
          </div>
        </form>
      </AuthFormShell>
    );
  }

  // ── Normal Login Screen ───────────────────────────────────────────────────
  return (
    <AuthFormShell
      titleKey="login.title"
      subtitleKey="login.subtitle"
      error={authError}
      onDismissError={clearError}
    >
      <form
        method="post"
        autoComplete="off"
        onSubmit={handleSubmit}
        className="industrial-login-form"
      >
        <Input
          surface="glass"
          className="industrial-auth-field"
          label={t('login.email')}
          type="email"
          name="email"
          value={formData.email}
          onChange={handleChange}
          error={errors.email}
          autoComplete="username"
          leftIcon={<EmailIcon />}
          size="lg"
          required
        />

        <PasswordInput
          surface="glass"
          className="industrial-auth-field industrial-password-field"
          label={t('login.password')}
          name="password"
          value={formData.password}
          onChange={handleChange}
          error={errors.password}
          autoComplete="current-password"
          maxLength={128}
          leftIcon={<PasswordIcon />}
          size="lg"
          required
          showPasswordLabel={t('common.showPassword')}
          hidePasswordLabel={t('common.hidePassword')}
          capsLockLabel={t('common.capsLockOn')}
        />

        <div className="industrial-login-options">
          <Checkbox
            surface="glass"
            className="industrial-login-remember"
            size="sm"
            label={t('login.rememberMe')}
            checked={formData.rememberMe}
            onChange={(e) => setFormData((prev) => ({ ...prev, rememberMe: e.target.checked }))}
          />
          <Link to="/forgot-password" className="industrial-auth-link">
            {t('login.forgotPassword')}
          </Link>
        </div>

        <Button
          surface="glass"
          type="submit"
          size="lg"
          fullWidth
          loading={isSubmitting}
          rightIcon={isSubmitting ? undefined : <ArrowRightIcon />}
          className="industrial-auth-submit"
        >
          {t('login.signIn')}
        </Button>

        {/* Mobile App Download Banner */}
        <div className="industrial-mobile-link-wrap">
          <a
            href="/mobile"
            target="_blank"
            rel="noopener noreferrer"
            className="industrial-mobile-link group"
          >
            <div className="industrial-mobile-icon">
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.8}
                aria-hidden="true"
              >
                <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                <line x1="12" y1="18" x2="12.01" y2="18" />
              </svg>
            </div>
            <div className="industrial-mobile-copy">
              <span>{t('login.mobile.title')}</span>
              <small>{t('login.mobile.subtitle')}</small>
            </div>
            <div className="industrial-mobile-arrow">
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.8}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                />
              </svg>
            </div>
          </a>
        </div>
      </form>
    </AuthFormShell>
  );
};

export default LoginForm;
