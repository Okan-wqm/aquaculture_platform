/**
 * Forgot-password form — requests a reset link. Glass surface + i18n SSoT.
 */
import React, { useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Button,
  Input,
  useI18n,
  required,
  email as emailValidator,
  validateField,
  publicGraphqlClient,
} from '@aquaculture/shared-ui';

import { AuthFormShell } from './AuthFormShell';
import { AuthStatusScreen } from './AuthStatusScreen';

const ForgotPasswordForm: React.FC = () => {
  const { t } = useI18n();
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
        // Pre-auth: sanctioned barrier-skipping client (no auth/tenant header),
        // not raw fetch. publicGraphqlClient throws GraphQLClientError on
        // GraphQL/transport errors → caught below.
        await publicGraphqlClient.request(
          `mutation ForgotPassword($input: ForgotPasswordInput!) {
              forgotPassword(input: $input)
            }`,
          { input: { email } },
        );
        setSuccess(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('common.error'));
      } finally {
        setIsSubmitting(false);
      }
    },
    [email, t],
  );

  if (success) {
    return (
      <AuthStatusScreen
        variant="success"
        titleKey="forgotPassword.success.title"
        message={t('forgotPassword.success.message')}
        showBackToLogin
      />
    );
  }

  return (
    <AuthFormShell
      titleKey="forgotPassword.title"
      subtitleKey="forgotPassword.subtitle"
      error={error}
      onDismissError={() => setError('')}
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <Input
          surface="glass"
          label={t('login.email')}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t('login.emailPlaceholder')}
          autoComplete="email"
          required
        />

        <Button surface="glass" type="submit" fullWidth loading={isSubmitting}>
          {t('forgotPassword.send')}
        </Button>

        <p className="text-center text-sm">
          <Link to="/login" className="font-medium text-[var(--surface-label-fg)] hover:underline">
            {t('forgotPassword.backToLogin')}
          </Link>
        </p>
      </form>
    </AuthFormShell>
  );
};

export default ForgotPasswordForm;
