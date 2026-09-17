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

const FingerprintIcon: React.FC = () => (
  <svg
    className="w-[18px] h-[18px]"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5 12a7 7 0 0 1 14 0" />
    <path d="M8 12a4 4 0 0 1 8 0v2" />
    <path d="M12 12v4" />
    <path d="M12 19v1" />
    <path d="M5 16c.5 1 1 1.6 2 2" />
    <path d="M19 16c-.5 1-1 1.6-2 2" />
  </svg>
);

const SsoCardIcon: React.FC = () => (
  <svg
    className="w-[18px] h-[18px]"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M8 10h8M8 14h5" />
  </svg>
);

const PhonePillIcon: React.FC = () => (
  <svg
    className="w-[13px] h-[13px]"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    aria-hidden="true"
  >
    <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
    <path d="M11 18.5h2" />
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
  const digitRefs = useRef<Array<HTMLInputElement | null>>([]);

  // TOTP digits rendered from the code string ("12345" → 1,2,3,4,5,'').
  const mfaDigits = Array.from({ length: 6 }, (_, i) => mfaCode[i] ?? '');

  const setDigitAt = useCallback((index: number, raw: string): void => {
    const v = raw.replace(/\D/g, '').slice(-1);
    setMfaCode((prev) => {
      const arr = Array.from({ length: 6 }, (_, k) => prev[k] ?? ' ');
      arr[index] = v || ' ';
      return arr.join('').replace(/ /g, '');
    });
    setMfaError('');
    if (v && index < 5) {
      digitRefs.current[index + 1]?.focus();
    }
  }, []);

  const handleDigitKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, index: number): void => {
      if (e.key === 'Backspace' && !e.currentTarget.value && index > 0) {
        digitRefs.current[index - 1]?.focus();
      }
    },
    [],
  );

  const handleDigitsPaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>): void => {
    const text = (e.clipboardData?.getData('text') ?? '').replace(/\D/g, '').slice(0, 6);
    if (text) {
      e.preventDefault();
      setMfaCode(text);
      setMfaError('');
      digitRefs.current[Math.min(text.length, 5)]?.focus();
    }
  }, []);

  useEffect(() => {
    if (!mfaChallenge) return;
    if (useRecoveryCode) {
      mfaInputRef.current?.focus();
    } else {
      digitRefs.current[0]?.focus();
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
              label={t('login.mfa.recoveryLabel')}
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
            <div className="industrial-mfa-digits" onPaste={handleDigitsPaste}>
              {mfaDigits.map((digit, i) => (
                <input
                  key={i}
                  ref={(el) => {
                    digitRefs.current[i] = el;
                  }}
                  className="industrial-mfa-digit"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={1}
                  value={digit}
                  aria-label={t('login.mfa.digitLabel', { n: i + 1 })}
                  onChange={(e) => setDigitAt(i, e.target.value)}
                  onKeyDown={(e) => handleDigitKeyDown(e, i)}
                />
              ))}
            </div>
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
            {t('login.mfa.verifyCode')}
          </Button>

          <div className="industrial-mfa-actions">
            <button type="button" onClick={handleBackToLogin} className="industrial-auth-link">
              ← {t('login.mfa.backToLogin')}
            </button>
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

        {/* or-divider — alternative sign-in methods below */}
        <div className="industrial-auth-divider" aria-hidden="true">
          <span />
          {t('login.orDivider')}
          <span />
        </div>

        {/* Passkey / SSO — visual only until the backend endpoints land */}
        <div className="industrial-auth-alt-buttons">
          <button type="button" className="industrial-auth-alt-btn" title={t('login.biometric')}>
            <FingerprintIcon />
            <span>{t('login.passkey')}</span>
          </button>
          <button type="button" className="industrial-auth-alt-btn" title={t('login.ssoTitle')}>
            <SsoCardIcon />
            <span>SSO</span>
          </button>
        </div>

        <p className="industrial-auth-no-account">
          {t('login.noAccount')}{' '}
          <button type="button" className="industrial-auth-link">
            {t('login.contactAdmin')}
          </button>
        </p>

        {/* AquaMobil — mobile field app */}
        <div className="industrial-mobile-link-wrap">
          <a
            href="/mobile"
            target="_blank"
            rel="noopener noreferrer"
            className="industrial-mobile-pill"
          >
            <PhonePillIcon />
            <span>{t('login.mobile.pill')}</span>
          </a>
        </div>
      </form>
    </AuthFormShell>
  );
};

export default LoginForm;
