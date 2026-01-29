/**
 * Login Page Component
 *
 * Unified login for all user roles:
 * - SUPER_ADMIN -> /admin/dashboard
 * - TENANT_ADMIN -> /tenant/dashboard
 * - MODULE_MANAGER/USER -> Module's defaultRoute
 */

import React, { useState, useCallback } from 'react';
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
} from '@aquaculture/shared-ui';

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
  const { login, error: authError, clearError } = useAuthContext();

  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

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
        // Login returns redirectPath based on user role
        const { redirectPath } = await login({
          email: formData.email,
          password: formData.password,
        });

        // Navigate to the appropriate dashboard
        navigate(redirectPath);
      } catch {
        // Auth context handles error display
      } finally {
        setIsSubmitting(false);
      }
    },
    [formData, login, navigate]
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
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
        autoComplete="email"
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

      <div className="text-center text-xs text-blue-600 mt-4">
        <p>Demo: by-okan@live.com / 12345678</p>
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
        // TODO: Call validateInvitation query
        // For now, simulate validation
        setInvitationData({
          email: 'invited@example.com',
          firstName: 'Invited',
          lastName: 'User',
          role: 'MODULE_MANAGER',
        });
        setFormData((prev) => ({
          ...prev,
          firstName: 'Invited',
          lastName: 'User',
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
        // TODO: Call acceptInvitation mutation
        navigate('/login');
      } catch (err) {
        setErrors({
          password: err instanceof Error ? err.message : 'An error occurred',
        });
      } finally {
        setIsSubmitting(false);
      }
    },
    [formData, navigate]
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
        // TODO: Call requestPasswordReset mutation
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
        // TODO: Call resetPassword mutation
        setSuccess(true);
        setTimeout(() => navigate('/login'), 3000);
      } catch (err) {
        setErrors({
          password: err instanceof Error ? err.message : 'An error occurred',
        });
      } finally {
        setIsSubmitting(false);
      }
    },
    [formData, token, navigate]
  );

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
