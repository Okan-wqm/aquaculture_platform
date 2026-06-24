/**
 * Login Page — thin router switch.
 *
 * The auth forms live in ./auth/ (AuthFormShell-composed, glass-surface, i18n).
 * This component only maps the route flag to the right form. Registration is
 * invitation-only, so /register falls through to the login form.
 */
import React from 'react';

import AcceptInvitationForm from './auth/AcceptInvitationForm';
import ForgotPasswordForm from './auth/ForgotPasswordForm';
import LoginForm from './auth/LoginForm';
import ResetPasswordForm from './auth/ResetPasswordForm';

interface LoginPageProps {
  isRegister?: boolean;
  isForgotPassword?: boolean;
  isResetPassword?: boolean;
  isAcceptInvitation?: boolean;
}

const LoginPage: React.FC<LoginPageProps> = ({
  isForgotPassword,
  isResetPassword,
  isAcceptInvitation,
}) => {
  if (isAcceptInvitation) return <AcceptInvitationForm />;
  if (isForgotPassword) return <ForgotPasswordForm />;
  if (isResetPassword) return <ResetPasswordForm />;
  return <LoginForm />;
};

export default LoginPage;
