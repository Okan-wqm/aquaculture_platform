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
  Alert,
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
} from '@aquaculture/shared-ui';
import type { MfaChallengeResult, MfaSetupRequiredResult } from '@aquaculture/shared-ui';

import { AuthFormShell } from './AuthFormShell';
import MfaSetupScreen from './MfaSetupScreen';

const LockIcon: React.FC = () => (
  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
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

  // ADR-042: tenant enforces MFA but this user has none enrolled. Login returns
  // a setup token (no session) → drive enrollment before completing login.
  const [mfaSetup, setMfaSetup] = useState<MfaSetupRequiredResult | null>(null);
  const [postSetupNotice, setPostSetupNotice] = useState('');

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
          setMfaChallenge(result);
          setMfaCode('');
          setMfaError('');
          setUseRecoveryCode(false);
          return;
        }

        if ('mfaSetupRequired' in result && result.mfaSetupRequired) {
          setMfaSetup(result);
          setPostSetupNotice('');
          return;
        }

        const redirectPath = (result as { redirectPath: string }).redirectPath;
        const safePath =
          redirectPath.startsWith('/') && !redirectPath.startsWith('//') ? redirectPath : '/';
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
        setMfaError(useRecoveryCode ? t('login.mfa.recoveryRequired') : t('login.mfa.codeRequired'));
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
        const safePath =
          redirectPath.startsWith('/') && !redirectPath.startsWith('//') ? redirectPath : '/';
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

  const handleBackFromSetup = useCallback(
    (options?: { enrolled: boolean }) => {
      setMfaSetup(null);
      // Clear the password so the user re-enters it on the fresh sign-in that
      // now flows through the normal MFA challenge.
      setFormData((prev) => ({ ...prev, password: '' }));
      setPostSetupNotice(
        options?.enrolled
          ? 'MFA is set up. Please sign in again to continue.'
          : '',
      );
      clearError();
    },
    [clearError],
  );

  // ── MFA Setup Screen (ADR-042 — tenant enforces MFA, user must enroll) ─────
  if (mfaSetup) {
    return <MfaSetupScreen challenge={mfaSetup} onBackToLogin={handleBackFromSetup} />;
  }

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
        <form onSubmit={handleMfaSubmit} className="space-y-5">
          {useRecoveryCode ? (
            <Input
              ref={mfaInputRef}
              surface="glass"
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

          <Button surface="glass" type="submit" fullWidth loading={isSubmitting}>
            {useRecoveryCode ? t('login.mfa.verifyRecovery') : t('login.mfa.verifyCode')}
          </Button>

          <div className="flex items-center justify-between text-sm pt-2">
            <button
              type="button"
              onClick={() => {
                setUseRecoveryCode(!useRecoveryCode);
                setMfaCode('');
                setMfaError('');
              }}
              className="font-medium text-[var(--surface-label-fg)] hover:underline"
            >
              {useRecoveryCode ? t('login.mfa.useAuthenticator') : t('login.mfa.useRecovery')}
            </button>
            <button
              type="button"
              onClick={handleBackToLogin}
              className="font-medium text-[var(--surface-label-fg)] hover:underline"
            >
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
      <form method="post" autoComplete="off" onSubmit={handleSubmit} className="space-y-5">
        {postSetupNotice && (
          <Alert type="success" dismissible onDismiss={() => setPostSetupNotice('')}>
            {postSetupNotice}
          </Alert>
        )}

        <Input
          surface="glass"
          label={t('login.email')}
          type="email"
          name="email"
          value={formData.email}
          onChange={handleChange}
          placeholder={t('login.emailPlaceholder')}
          error={errors.email}
          autoComplete="username"
          required
        />

        <PasswordInput
          surface="glass"
          label={t('login.password')}
          name="password"
          value={formData.password}
          onChange={handleChange}
          placeholder={t('login.passwordPlaceholder')}
          error={errors.password}
          autoComplete="current-password"
          maxLength={128}
          required
          showPasswordLabel={t('common.showPassword')}
          hidePasswordLabel={t('common.hidePassword')}
          capsLockLabel={t('common.capsLockOn')}
        />

        <div className="flex items-center justify-between text-sm">
          <Checkbox
            surface="glass"
            label={t('login.rememberMe')}
            checked={formData.rememberMe}
            onChange={(e) => setFormData((prev) => ({ ...prev, rememberMe: e.target.checked }))}
          />
          <Link
            to="/forgot-password"
            className="font-medium text-[var(--surface-label-fg)] hover:underline"
          >
            {t('login.forgotPassword')}
          </Link>
        </div>

        <Button surface="glass" type="submit" fullWidth loading={isSubmitting}>
          {t('login.signIn')}
        </Button>

        {/* Mobile App Download Banner */}
        <div className="mt-6 pt-5 border-t border-primary-200/50">
          <a
            href="/mobile"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 p-3 bg-gradient-to-r from-primary-50 to-secondary-50 hover:from-primary-100 hover:to-secondary-100 rounded-xl border border-primary-200/60 transition-all group"
          >
            <div className="w-10 h-10 bg-primary-600 rounded-xl flex items-center justify-center flex-shrink-0 shadow-md group-hover:scale-105 transition-transform">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                <line x1="12" y1="18" x2="12.01" y2="18" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold text-[var(--surface-heading-fg)]">{t('login.mobile.title')}</div>
              <div className="text-xs text-[var(--surface-muted-fg)]">{t('login.mobile.subtitle')}</div>
            </div>
            <div className="text-[var(--surface-label-fg)] group-hover:translate-x-0.5 transition-transform flex-shrink-0">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </div>
          </a>
        </div>
      </form>
    </AuthFormShell>
  );
};

export default LoginForm;
