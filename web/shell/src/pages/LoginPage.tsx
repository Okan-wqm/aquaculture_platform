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
        <h2 className="text-2xl font-bold text-gray-900">Giriş Yap</h2>
        <p className="mt-1 text-sm text-gray-500">Hesabınıza giriş yapın</p>
      </div>

      {authError && (
        <Alert type="error" dismissible onDismiss={clearError}>
          {authError}
        </Alert>
      )}

      <Input
        label="E-posta"
        type="email"
        name="email"
        value={formData.email}
        onChange={handleChange}
        placeholder="ornek@email.com"
        error={errors.email}
        autoComplete="email"
        required
      />

      <Input
        label="Şifre"
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
          <input type="checkbox" className="rounded border-gray-300 text-primary-600" />
          <span className="ml-2 text-gray-600">Beni hatırla</span>
        </label>
        <Link to="/forgot-password" className="text-primary-600 hover:text-primary-700 font-medium">
          Şifremi unuttum
        </Link>
      </div>

      <Button type="submit" fullWidth loading={isSubmitting}>
        Giriş Yap
      </Button>

      <div className="text-center text-xs text-gray-500 mt-4">
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
        setValidationError('Geçersiz davet bağlantısı');
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
        setValidationError('Davet bağlantısı geçersiz veya süresi dolmuş');
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

      if (!formData.firstName.trim()) newErrors.firstName = 'Ad zorunludur';
      if (!formData.lastName.trim()) newErrors.lastName = 'Soyad zorunludur';

      const passwordResult = validateField(formData.password, [required(), minLength(8)]);
      if (!passwordResult.valid) newErrors.password = passwordResult.error || '';

      if (formData.password !== formData.confirmPassword) {
        newErrors.confirmPassword = 'Şifreler eşleşmiyor';
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
          password: err instanceof Error ? err.message : 'Bir hata oluştu',
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
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto"></div>
        <p className="mt-4 text-gray-600">Davet doğrulanıyor...</p>
      </div>
    );
  }

  if (validationError) {
    return (
      <div className="text-center">
        <div className="mx-auto w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mb-4">
          <svg className="w-6 h-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-gray-900 mb-2">Geçersiz Davet</h2>
        <p className="text-gray-600 mb-6">{validationError}</p>
        <Link to="/login">
          <Button variant="outline" fullWidth>
            Giriş sayfasına dön
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Daveti Kabul Et</h2>
        <p className="mt-1 text-sm text-gray-500">Hesabınızı tamamlayın</p>
        {invitationData && (
          <p className="mt-2 text-sm text-primary-600">{invitationData.email}</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Input
          label="Ad"
          name="firstName"
          value={formData.firstName}
          onChange={handleChange}
          placeholder="Ad"
          error={errors.firstName}
          required
        />
        <Input
          label="Soyad"
          name="lastName"
          value={formData.lastName}
          onChange={handleChange}
          placeholder="Soyad"
          error={errors.lastName}
          required
        />
      </div>

      <Input
        label="Şifre"
        type="password"
        name="password"
        value={formData.password}
        onChange={handleChange}
        placeholder="En az 8 karakter"
        error={errors.password}
        hint="En az 8 karakter"
        autoComplete="new-password"
        required
      />

      <Input
        label="Şifre Tekrar"
        type="password"
        name="confirmPassword"
        value={formData.confirmPassword}
        onChange={handleChange}
        placeholder="Şifreyi tekrar girin"
        error={errors.confirmPassword}
        autoComplete="new-password"
        required
      />

      <Button type="submit" fullWidth loading={isSubmitting}>
        Hesabı Oluştur
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
        setError(err instanceof Error ? err.message : 'Bir hata oluştu');
      } finally {
        setIsSubmitting(false);
      }
    },
    [email]
  );

  if (success) {
    return (
      <div className="text-center">
        <div className="mx-auto w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mb-4">
          <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-gray-900 mb-2">E-posta Gönderildi</h2>
        <p className="text-gray-600 mb-6">
          Şifre sıfırlama bağlantısı e-posta adresinize gönderildi.
        </p>
        <Link to="/login">
          <Button variant="outline" fullWidth>
            Giriş sayfasına dön
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Şifremi Unuttum</h2>
        <p className="mt-1 text-sm text-gray-500">
          E-posta adresinize şifre sıfırlama bağlantısı göndereceğiz
        </p>
      </div>

      {error && (
        <Alert type="error" dismissible onDismiss={() => setError('')}>
          {error}
        </Alert>
      )}

      <Input
        label="E-posta"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="ornek@email.com"
        autoComplete="email"
        required
      />

      <Button type="submit" fullWidth loading={isSubmitting}>
        Şifre Sıfırlama Bağlantısı Gönder
      </Button>

      <p className="text-center text-sm text-gray-600">
        <Link to="/login" className="text-primary-600 hover:text-primary-700 font-medium">
          Giriş sayfasına dön
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
        newErrors.confirmPassword = 'Şifreler eşleşmiyor';
      }

      if (Object.keys(newErrors).length > 0) {
        setErrors(newErrors);
        return;
      }

      if (!token) {
        setErrors({ password: 'Geçersiz sıfırlama bağlantısı' });
        return;
      }

      setIsSubmitting(true);

      try {
        // TODO: Call resetPassword mutation
        setSuccess(true);
        setTimeout(() => navigate('/login'), 3000);
      } catch (err) {
        setErrors({
          password: err instanceof Error ? err.message : 'Bir hata oluştu',
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
        <div className="mx-auto w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mb-4">
          <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-gray-900 mb-2">Şifre Sıfırlandı</h2>
        <p className="text-gray-600 mb-6">
          Şifreniz başarıyla sıfırlandı. Giriş sayfasına yönlendiriliyorsunuz...
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Yeni Şifre Belirle</h2>
        <p className="mt-1 text-sm text-gray-500">Yeni şifrenizi girin</p>
      </div>

      <Input
        label="Yeni Şifre"
        type="password"
        name="password"
        value={formData.password}
        onChange={handleChange}
        placeholder="En az 8 karakter"
        error={errors.password}
        hint="En az 8 karakter"
        autoComplete="new-password"
        required
      />

      <Input
        label="Şifre Tekrar"
        type="password"
        name="confirmPassword"
        value={formData.confirmPassword}
        onChange={handleChange}
        placeholder="Şifreyi tekrar girin"
        error={errors.confirmPassword}
        autoComplete="new-password"
        required
      />

      <Button type="submit" fullWidth loading={isSubmitting}>
        Şifreyi Sıfırla
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
