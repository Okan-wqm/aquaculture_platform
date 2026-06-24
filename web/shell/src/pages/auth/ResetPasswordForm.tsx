/**
 * Reset-password form — sets a new password from a reset token. Glass surface +
 * i18n SSoT + PasswordInput (show/hide + caps-lock).
 */
import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Button,
  PasswordInput,
  useI18n,
  required,
  minLength,
  validateField,
} from '@aquaculture/shared-ui';

import { AuthFormShell } from './AuthFormShell';
import { AuthStatusScreen } from './AuthStatusScreen';

const ResetPasswordForm: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { token } = useParams<{ token: string }>();

  const [formData, setFormData] = useState({ password: '', confirmPassword: '' });
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
        newErrors.confirmPassword = t('validation.passwordMismatch');
      }
      if (Object.keys(newErrors).length > 0) {
        setErrors(newErrors);
        return;
      }
      if (!token) {
        setErrors({ password: t('invitation.invalid.generic') });
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
            variables: { input: { token, newPassword: formData.password } },
          }),
        });
        const result = await response.json();
        if (result.errors) {
          throw new Error(result.errors[0]?.message || t('common.error'));
        }
        setSuccess(true);
      } catch (err) {
        setErrors({ password: err instanceof Error ? err.message : t('common.error') });
      } finally {
        setIsSubmitting(false);
      }
    },
    [formData, token, t],
  );

  // Navigate to login after success with cleanup on unmount
  useEffect(() => {
    if (!success) return;
    const id = setTimeout(() => navigate('/login'), 3000);
    return () => clearTimeout(id);
  }, [success, navigate]);

  if (success) {
    return (
      <AuthStatusScreen
        variant="success"
        titleKey="resetPassword.success.title"
        message={t('resetPassword.success.message')}
      />
    );
  }

  const pwLabels = {
    showPasswordLabel: t('common.showPassword'),
    hidePasswordLabel: t('common.hidePassword'),
    capsLockLabel: t('common.capsLockOn'),
  };

  return (
    <AuthFormShell titleKey="resetPassword.title" subtitleKey="resetPassword.subtitle">
      <form onSubmit={handleSubmit} className="space-y-5">
        <PasswordInput
          surface="glass"
          label={t('resetPassword.newPassword')}
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
          label={t('resetPassword.confirmPassword')}
          name="confirmPassword"
          value={formData.confirmPassword}
          onChange={handleChange}
          error={errors.confirmPassword}
          autoComplete="new-password"
          required
          {...pwLabels}
        />

        <Button surface="glass" type="submit" fullWidth loading={isSubmitting}>
          {t('resetPassword.submit')}
        </Button>
      </form>
    </AuthFormShell>
  );
};

export default ResetPasswordForm;
