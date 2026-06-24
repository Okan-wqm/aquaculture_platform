/**
 * AuthStatusScreen — SSoT for the four near-identical success/error result
 * screens (email sent, password reset, invitation invalid, …). One icon-circle
 * + title + message + optional back-to-login link, all on glass-surface tokens.
 */
import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Button, useI18n, type MessageKey } from '@aquaculture/shared-ui';

export interface AuthStatusScreenProps {
  variant: 'success' | 'error';
  titleKey: MessageKey;
  /** Already-resolved message (some are dynamic), so accept a node. */
  message: React.ReactNode;
  showBackToLogin?: boolean;
}

const CheckIcon: React.FC = () => (
  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
  </svg>
);

const XIcon: React.FC = () => (
  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
  </svg>
);

export const AuthStatusScreen: React.FC<AuthStatusScreenProps> = ({
  variant,
  titleKey,
  message,
  showBackToLogin = false,
}) => {
  const { t } = useI18n();
  const isSuccess = variant === 'success';

  // This screen mounts in place of the form (no route change), so move focus to
  // the heading on mount and mark the region role=status/alert so assistive tech
  // announces the result (a11y MEDIUM — in-place swaps were silent).
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="text-center" role={isSuccess ? 'status' : 'alert'}>
      <div
        className={`mx-auto w-12 h-12 rounded-full flex items-center justify-center mb-4 ${
          isSuccess ? 'bg-success-100 text-success-600' : 'bg-error-100 text-error-600'
        }`}
      >
        {isSuccess ? <CheckIcon /> : <XIcon />}
      </div>
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="text-xl font-bold text-[var(--surface-heading-fg)] mb-2 outline-none"
      >
        {t(titleKey)}
      </h2>
      <p className="text-[var(--surface-muted-fg)] mb-6">{message}</p>
      {showBackToLogin && (
        <Link to="/login">
          <Button surface="glass" fullWidth>
            {t('forgotPassword.backToLogin')}
          </Button>
        </Link>
      )}
    </div>
  );
};

export default AuthStatusScreen;
