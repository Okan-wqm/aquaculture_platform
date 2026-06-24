/**
 * Accept-invitation form — validates the invite token then provisions the
 * account. Glass surface + i18n SSoT + PasswordInput.
 */
import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Button,
  Input,
  PasswordInput,
  useI18n,
  required,
  minLength,
  validateField,
  clearSession,
} from '@aquaculture/shared-ui';

import { AuthFormShell } from './AuthFormShell';
import { AuthStatusScreen } from './AuthStatusScreen';

const AcceptInvitationForm: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { token } = useParams<{ token: string }>();

  const [invitationData, setInvitationData] = useState<{ email: string } | null>(null);
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

  useEffect(() => {
    const validateToken = async (): Promise<void> => {
      if (!token) {
        setValidationError(t('invitation.invalid.generic'));
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
          throw new Error(result.errors[0]?.message || t('common.error'));
        }
        const data = result.data.validateInvitation;
        if (!data.valid) {
          setValidationError(data.expired ? t('invitation.invalid.expired') : t('invitation.invalid.generic'));
          setIsValidating(false);
          return;
        }
        setInvitationData({ email: data.email });
        setFormData((prev) => ({
          ...prev,
          firstName: data.firstName || '',
          lastName: data.lastName || '',
        }));
      } catch {
        setValidationError(t('invitation.invalid.generic'));
      } finally {
        setIsValidating(false);
      }
    };

    void validateToken();
  }, [token, t]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    setErrors((prev) => ({ ...prev, [name]: '' }));
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      const newErrors: Record<string, string> = {};
      if (!formData.firstName.trim()) newErrors.firstName = t('validation.required');
      if (!formData.lastName.trim()) newErrors.lastName = t('validation.required');
      const passwordResult = validateField(formData.password, [required(), minLength(8)]);
      if (!passwordResult.valid) newErrors.password = passwordResult.error || '';
      if (formData.password !== formData.confirmPassword) {
        newErrors.confirmPassword = t('validation.passwordMismatch');
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
          throw new Error(result.errors[0]?.message || t('common.error'));
        }
        // Clear any existing session so the user authenticates fresh.
        clearSession();
        navigate('/login');
      } catch (err) {
        setErrors({ password: err instanceof Error ? err.message : t('common.error') });
      } finally {
        setIsSubmitting(false);
      }
    },
    [formData, navigate, token, t],
  );

  if (isValidating) {
    return (
      <div className="text-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--surface-heading-fg)] mx-auto" />
        <p className="mt-4 text-[var(--surface-muted-fg)]">{t('invitation.validating')}</p>
      </div>
    );
  }

  if (validationError) {
    return (
      <AuthStatusScreen
        variant="error"
        titleKey="invitation.invalid.title"
        message={validationError}
        showBackToLogin
      />
    );
  }

  const pwLabels = {
    showPasswordLabel: t('common.showPassword'),
    hidePasswordLabel: t('common.hidePassword'),
    capsLockLabel: t('common.capsLockOn'),
  };

  return (
    <AuthFormShell titleKey="invitation.title" subtitleKey="invitation.subtitle">
      {invitationData && (
        <p className="text-center -mt-4 mb-4 text-sm text-[var(--surface-label-fg)]">{invitationData.email}</p>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Input
            surface="glass"
            label={t('invitation.firstName')}
            name="firstName"
            value={formData.firstName}
            onChange={handleChange}
            error={errors.firstName}
            required
          />
          <Input
            surface="glass"
            label={t('invitation.lastName')}
            name="lastName"
            value={formData.lastName}
            onChange={handleChange}
            error={errors.lastName}
            required
          />
        </div>

        <PasswordInput
          surface="glass"
          label={t('invitation.password')}
          name="password"
          value={formData.password}
          onChange={handleChange}
          error={errors.password}
          hint={t('validation.minLength', { min: 8 })}
          autoComplete="new-password"
          required
          {...pwLabels}
        />

        <PasswordInput
          surface="glass"
          label={t('invitation.confirmPassword')}
          name="confirmPassword"
          value={formData.confirmPassword}
          onChange={handleChange}
          error={errors.confirmPassword}
          autoComplete="new-password"
          required
          {...pwLabels}
        />

        <Button surface="glass" type="submit" fullWidth loading={isSubmitting}>
          {t('invitation.submit')}
        </Button>
      </form>
    </AuthFormShell>
  );
};

export default AcceptInvitationForm;
