/**
 * Login Page Component
 *
 * Unified login for all user roles:
 * - SUPER_ADMIN -> /admin/dashboard
 * - TENANT_ADMIN -> /tenant/dashboard
 * - MODULE_MANAGER/USER -> Module's defaultRoute
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Button,
  Input,
  Alert,
  useAuthContext,
  required,
  email as emailValidator,
  minLength,
  validateField,
  clearSession,
} from '@aquaculture/shared-ui';
import type { MfaChallengeResult } from '@aquaculture/shared-ui';

// ============================================================================
// Types
// ============================================================================

interface LoginPageProps {
  isRegister?: boolean;
  isForgotPassword?: boolean;
  isResetPassword?: boolean;
  isAcceptInvitation?: boolean;
}

// ============================================================================
// Login Form Component
// ============================================================================

const LoginForm: React.FC = () => {
  const navigate = useNavigate();
  const { login, verifyMfaLogin, error: authError, clearError } = useAuthContext();

  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // MFA challenge state
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallengeResult | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaError, setMfaError] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const mfaInputRef = useRef<HTMLInputElement>(null);

  // Focus MFA input when challenge appears
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
    [clearError]
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      // Validation
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
        });

        // Check if MFA is required
        if ('mfaRequired' in result && result.mfaRequired) {
          setMfaChallenge(result as MfaChallengeResult);
          setMfaCode('');
          setMfaError('');
          setUseRecoveryCode(false);
          return;
        }

        // Normal login — navigate to redirect path
        const redirectPath = (result as { redirectPath: string }).redirectPath;
        const safePath =
          redirectPath.startsWith('/') && !redirectPath.startsWith('//')
            ? redirectPath
            : '/';
        navigate(safePath);
      } catch {
        // Auth context handles error display
      } finally {
        setIsSubmitting(false);
      }
    },
    [formData, login, navigate]
  );

  const handleMfaSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      if (!mfaChallenge) return;

      const code = mfaCode.trim();
      if (!code) {
        setMfaError(useRecoveryCode ? 'Recovery code is required' : 'Verification code is required');
        return;
      }

      // TOTP codes are exactly 6 digits; recovery codes are 6-12 chars
      if (!useRecoveryCode && !/^\d{6}$/.test(code)) {
        setMfaError('Enter a 6-digit code from your authenticator app');
        return;
      }

      if (useRecoveryCode && (code.length < 6 || code.length > 12)) {
        setMfaError('Recovery code must be between 6 and 12 characters');
        return;
      }

      setIsSubmitting(true);
      setMfaError('');

      try {
        const { redirectPath } = await verifyMfaLogin({
          mfaToken: mfaChallenge.mfaToken,
          code,
        });

        const safePath =
          redirectPath.startsWith('/') && !redirectPath.startsWith('//')
            ? redirectPath
            : '/';
        navigate(safePath);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Verification failed';
        setMfaError(message);
        setMfaCode('');
        // Clear authError so only mfaError is displayed (verifyMfaLogin dispatches AUTH_FAILURE)
        clearError();
      } finally {
        setIsSubmitting(false);
      }
    },
    [mfaChallenge, mfaCode, useRecoveryCode, verifyMfaLogin, navigate, clearError]
  );

  const handleBackToLogin = useCallback(() => {
    setMfaChallenge(null);
    setMfaCode('');
    setMfaError('');
    setUseRecoveryCode(false);
    clearError();
  }, [clearError]);

  // ── MFA Challenge Screen ──────────────────────────────────────────────────
  if (mfaChallenge) {
    return (
      <form onSubmit={handleMfaSubmit} className="space-y-5">
        <div className="text-center mb-6">
          <div className="mx-auto w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center mb-4">
            <svg className="w-6 h-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-blue-700">Two-Factor Authentication</h2>
          <p className="mt-1 text-sm text-blue-600">
            {useRecoveryCode
              ? 'Enter one of your recovery codes'
              : 'Enter the 6-digit code from your authenticator app'}
          </p>
        </div>

        {mfaError && (
          <Alert type="error" dismissible onDismiss={() => setMfaError('')}>
            {mfaError}
          </Alert>
        )}

        {authError && (
          <Alert type="error" dismissible onDismiss={clearError}>
            {authError}
          </Alert>
        )}

        {useRecoveryCode ? (
          <Input
            ref={mfaInputRef}
            label="Recovery Code"
            type="text"
            name="recoveryCode"
            value={mfaCode}
            onChange={(e) => {
              setMfaCode(e.target.value);
              setMfaError('');
            }}
            placeholder="Enter recovery code"
            autoComplete="off"
            required
          />
        ) : (
          <Input
            ref={mfaInputRef}
            label="Verification Code"
            type="text"
            inputMode="numeric"
            name="mfaCode"
            value={mfaCode}
            onChange={(e) => {
              // Allow only digits, max 6 characters
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

        <Button type="submit" fullWidth loading={isSubmitting}>
          {useRecoveryCode ? 'Verify Recovery Code' : 'Verify Code'}
        </Button>

        <div className="flex items-center justify-between text-sm pt-2">
          <button
            type="button"
            onClick={() => {
              setUseRecoveryCode(!useRecoveryCode);
              setMfaCode('');
              setMfaError('');
            }}
            className="text-blue-600 hover:text-blue-800 font-medium"
          >
            {useRecoveryCode ? 'Use authenticator app' : 'Use a recovery code'}
          </button>
          <button
            type="button"
            onClick={handleBackToLogin}
            className="text-blue-600 hover:text-blue-800 font-medium"
          >
            Back to login
          </button>
        </div>
      </form>
    );
  }

  // ── Normal Login Screen ───────────────────────────────────────────────────
  return (
    <form method="post" autoComplete="off" onSubmit={handleSubmit} className="space-y-5">
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-blue-700">Sign In</h2>
        <p className="mt-1 text-sm text-blue-600">Access your account</p>
      </div>

      {authError && (
        <Alert type="error" dismissible onDismiss={clearError}>
          {authError}
        </Alert>
      )}

      <Input
        label="Email"
        type="email"
        name="email"
        value={formData.email}
        onChange={handleChange}
        placeholder="example@email.com"
        error={errors.email}
        autoComplete="username"
        required
      />

      <Input
        label="Password"
        type="password"
        name="password"
        value={formData.password}
        onChange={handleChange}
        placeholder="••••••••"
        error={errors.password}
        autoComplete="current-password"
        minLength={8}
        maxLength={128}
        required
      />

      <div className="flex items-center justify-between text-sm">
        <label className="flex items-center">
          <input type="checkbox" className="rounded border-blue-300 bg-white/50 text-blue-600" />
          <span className="ml-2 text-blue-700">Remember me</span>
        </label>
        <Link to="/forgot-password" className="text-blue-600 hover:text-blue-800 font-medium">
          Forgot password?
        </Link>
      </div>

      <Button type="submit" fullWidth loading={isSubmitting}>
        Sign In
      </Button>

      {/* Mobile App Download Banner */}
      <div className="mt-6 pt-5 border-t border-blue-200/50">
        <a
          href="/mobile"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 p-3 bg-gradient-to-r from-blue-50 to-sky-50 hover:from-blue-100 hover:to-sky-100 rounded-xl border border-blue-200/60 transition-all group"
        >
          <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center flex-shrink-0 shadow-md group-hover:scale-105 transition-transform">
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
              <line x1="12" y1="18" x2="12.01" y2="18" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-blue-800">AquaMobil</div>
            <div className="text-xs text-blue-600">Mobile field data entry app</div>
          </div>
          <div className="text-blue-400 group-hover:text-blue-600 transition-colors flex-shrink-0">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </div>
        </a>
      </div>
    </form>
  );
};

// ============================================================================
// Accept Invitation Form Component
// ============================================================================

const AcceptInvitationForm: React.FC = () => {
  const navigate = useNavigate();
  const { token } = useParams<{ token: string }>();
  const [invitationData, setInvitationData] = useState<{
    email: string;
    firstName?: string;
    lastName?: string;
    role?: string;
  } | null>(null);
  const [formData, setFormData] = useState({
    password: '',
    confirmPassword: '',
    firstName: '',
    lastName: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isValidating, setIsValidating] = useState(true);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Validate invitation token on mount
  React.useEffect(() => {
    const validateToken = async () => {
      if (!token) {
        setValidationError('Invalid invitation link');
        setIsValidating(false);
        return;
      }

      try {
        const response = await fetch('/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: `query ValidateInvitation($token: String!) {
              validateInvitation(token: $token) {
                valid
                email
                role
                firstName
                lastName
                expired
              }
            }`,
            variables: { token },
          }),
        });

        const result = await response.json();

        if (result.errors) {
          throw new Error(result.errors[0]?.message || 'Validation failed');
        }

        const data = result.data.validateInvitation;

        if (!data.valid) {
          setValidationError(data.expired ? 'Invitation has expired' : 'Invitation link is invalid or expired');
          setIsValidating(false);
          return;
        }

        setInvitationData({
          email: data.email,
          firstName: data.firstName,
          lastName: data.lastName,
          role: data.role,
        });
        setFormData((prev) => ({
          ...prev,
          firstName: data.firstName || '',
          lastName: data.lastName || '',
        }));
      } catch {
        setValidationError('Invitation link is invalid or expired');
      } finally {
        setIsValidating(false);
      }
    };

    validateToken();
  }, [token]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    setErrors((prev) => ({ ...prev, [name]: '' }));
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      const newErrors: Record<string, string> = {};

      if (!formData.firstName.trim()) newErrors.firstName = 'First name is required';
      if (!formData.lastName.trim()) newErrors.lastName = 'Last name is required';

      const passwordResult = validateField(formData.password, [required(), minLength(8)]);
      if (!passwordResult.valid) newErrors.password = passwordResult.error || '';

      if (formData.password !== formData.confirmPassword) {
        newErrors.confirmPassword = 'Passwords do not match';
      }

      if (Object.keys(newErrors).length > 0) {
        setErrors(newErrors);
        return;
      }

      setIsSubmitting(true);

      try {
        const response = await fetch('/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: `mutation AcceptInvitation($input: AcceptInvitationInput!) {
              acceptInvitation(input: $input) {
                accessToken
              }
            }`,
            variables: {
              input: {
                token,
                password: formData.password,
                firstName: formData.firstName,
                lastName: formData.lastName,
              },
            },
          }),
        });

        const result = await response.json();

        if (result.errors) {
          throw new Error(result.errors[0]?.message || 'Failed to accept invitation');
        }

        // Clear any existing session before redirecting to login
        // so the user must authenticate fresh with their new credentials
        clearSession();
        navigate('/login');
      } catch (err) {
        setErrors({
          password: err instanceof Error ? err.message : 'An error occurred',
        });
      } finally {
        setIsSubmitting(false);
      }
    },
    [formData, navigate, token]
  );

  if (isValidating) {
    return (
      <div className="text-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto"></div>
        <p className="mt-4 text-white/80">Validating invitation...</p>
      </div>
    );
  }

  if (validationError) {
    return (
      <div className="text-center">
        <div className="mx-auto w-12 h-12 bg-red-500/30 rounded-full flex items-center justify-center mb-4">
          <svg className="w-6 h-6 text-red-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-white mb-2">Invalid Invitation</h2>
        <p className="text-white/70 mb-6">{validationError}</p>
        <Link to="/login">
          <Button variant="outline" fullWidth>
            Back to login
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-white drop-shadow-md">Accept Invitation</h2>
        <p className="mt-1 text-sm text-white/80">Complete your account</p>
        {invitationData && (
          <p className="mt-2 text-sm text-primary-600">{invitationData.email}</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Input
          label="First Name"
          name="firstName"
          value={formData.firstName}
          onChange={handleChange}
          placeholder="First name"
          error={errors.firstName}
          required
        />
        <Input
          label="Last Name"
          name="lastName"
          value={formData.lastName}
          onChange={handleChange}
          placeholder="Last name"
          error={errors.lastName}
          required
        />
      </div>

      <Input
        label="Password"
        type="password"
        name="password"
        value={formData.password}
        onChange={handleChange}
        placeholder="At least 8 characters"
        error={errors.password}
        hint="At least 8 characters"
        autoComplete="new-password"
        required
      />

      <Input
        label="Confirm Password"
        type="password"
        name="confirmPassword"
        value={formData.confirmPassword}
        onChange={handleChange}
        placeholder="Re-enter password"
        error={errors.confirmPassword}
        autoComplete="new-password"
        required
      />

      <Button type="submit" fullWidth loading={isSubmitting}>
        Create Account
      </Button>
    </form>
  );
};

// ============================================================================
// Forgot Password Form Component
// ============================================================================

const ForgotPasswordForm: React.FC = () => {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      const result = validateField(email, [required(), emailValidator()]);
      if (!result.valid) {
        setError(result.error || '');
        return;
      }

      setIsSubmitting(true);
      setError('');

      try {
        const response = await fetch('/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: `mutation ForgotPassword($input: ForgotPasswordInput!) {
              forgotPassword(input: $input)
            }`,
            variables: { input: { email } },
          }),
        });

        const data = await response.json();

        if (data.errors) {
          throw new Error(data.errors[0]?.message || 'Failed to send reset email');
        }

        setSuccess(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        setIsSubmitting(false);
      }
    },
    [email]
  );

  if (success) {
    return (
      <div className="text-center">
        <div className="mx-auto w-12 h-12 bg-green-500/30 rounded-full flex items-center justify-center mb-4">
          <svg className="w-6 h-6 text-green-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-white mb-2">Email Sent</h2>
        <p className="text-white/70 mb-6">
          Password reset link has been sent to your email address.
        </p>
        <Link to="/login">
          <Button variant="outline" fullWidth>
            Back to login
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-white drop-shadow-md">Forgot Password</h2>
        <p className="mt-1 text-sm text-white/80">
          We'll send a password reset link to your email
        </p>
      </div>

      {error && (
        <Alert type="error" dismissible onDismiss={() => setError('')}>
          {error}
        </Alert>
      )}

      <Input
        label="Email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="example@email.com"
        autoComplete="email"
        required
      />

      <Button type="submit" fullWidth loading={isSubmitting}>
        Send Reset Link
      </Button>

      <p className="text-center text-sm text-white/70">
        <Link to="/login" className="text-white hover:text-white/80 font-medium">
          Back to login
        </Link>
      </p>
    </form>
  );
};

// ============================================================================
// Reset Password Form Component
// ============================================================================

const ResetPasswordForm: React.FC = () => {
  const navigate = useNavigate();
  const { token } = useParams<{ token: string }>();

  const [formData, setFormData] = useState({
    password: '',
    confirmPassword: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    setErrors((prev) => ({ ...prev, [name]: '' }));
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      const newErrors: Record<string, string> = {};

      const passwordResult = validateField(formData.password, [required(), minLength(8)]);
      if (!passwordResult.valid) newErrors.password = passwordResult.error || '';

      if (formData.password !== formData.confirmPassword) {
        newErrors.confirmPassword = 'Passwords do not match';
      }

      if (Object.keys(newErrors).length > 0) {
        setErrors(newErrors);
        return;
      }

      if (!token) {
        setErrors({ password: 'Invalid reset link' });
        return;
      }

      setIsSubmitting(true);

      try {
        const response = await fetch('/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: `mutation ResetPassword($input: ResetPasswordInput!) {
              resetPassword(input: $input) {
                accessToken
              }
            }`,
            variables: {
              input: {
                token,
                newPassword: formData.password,
              },
            },
          }),
        });

        const result = await response.json();

        if (result.errors) {
          throw new Error(result.errors[0]?.message || 'Failed to reset password');
        }

        setSuccess(true);
      } catch (err) {
        setErrors({
          password: err instanceof Error ? err.message : 'An error occurred',
        });
      } finally {
        setIsSubmitting(false);
      }
    },
    [formData, token]
  );

  // Navigate to login after success with cleanup on unmount
  useEffect(() => {
    if (!success) return;
    const id = setTimeout(() => navigate('/login'), 3000);
    return () => clearTimeout(id);
  }, [success, navigate]);

  if (success) {
    return (
      <div className="text-center">
        <div className="mx-auto w-12 h-12 bg-green-500/30 rounded-full flex items-center justify-center mb-4">
          <svg className="w-6 h-6 text-green-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-white mb-2">Password Reset</h2>
        <p className="text-white/70 mb-6">
          Your password has been reset successfully. Redirecting to login...
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-white drop-shadow-md">Set New Password</h2>
        <p className="mt-1 text-sm text-white/80">Enter your new password</p>
      </div>

      <Input
        label="New Password"
        type="password"
        name="password"
        value={formData.password}
        onChange={handleChange}
        placeholder="At least 8 characters"
        error={errors.password}
        hint="At least 8 characters"
        autoComplete="new-password"
        required
      />

      <Input
        label="Confirm Password"
        type="password"
        name="confirmPassword"
        value={formData.confirmPassword}
        onChange={handleChange}
        placeholder="Re-enter password"
        error={errors.confirmPassword}
        autoComplete="new-password"
        required
      />

      <Button type="submit" fullWidth loading={isSubmitting}>
        Reset Password
      </Button>
    </form>
  );
};

// ============================================================================
// Main Component
// ============================================================================

const LoginPage: React.FC<LoginPageProps> = ({
  isRegister,
  isForgotPassword,
  isResetPassword,
  isAcceptInvitation,
}) => {
  if (isAcceptInvitation) {
    return <AcceptInvitationForm />;
  }

  if (isRegister) {
    // Registration is typically done via invitation, redirect to login
    return <LoginForm />;
  }

  if (isForgotPassword) {
    return <ForgotPasswordForm />;
  }

  if (isResetPassword) {
    return <ResetPasswordForm />;
  }

  return <LoginForm />;
};

export default LoginPage;
