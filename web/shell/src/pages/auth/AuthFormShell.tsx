/**
 * AuthFormShell — SSoT chrome for every auth form's heading region.
 *
 * WHY: the four auth forms each duplicated a heading + subtitle + error block,
 * and three of them picked `text-white` on the light frosted card (a WCAG
 * contrast bug, ORPHAN-MEDIUM-133). Routing every heading through this one
 * component — which draws ONLY from the glass-surface foreground tokens — makes
 * that bug structurally impossible: a form cannot choose a low-contrast color
 * because it never renders its own heading.
 */
import React from 'react';
import { Alert, useI18n, type MessageKey } from '@aquaculture/shared-ui';

export interface AuthFormShellProps {
  titleKey: MessageKey;
  subtitleKey?: MessageKey;
  /** Optional icon shown above the title (e.g. the MFA lock). */
  icon?: React.ReactNode;
  /** Single error string for this form; rendered in one aria-live region. */
  error?: string | null;
  onDismissError?: () => void;
  children: React.ReactNode;
}

export const AuthFormShell: React.FC<AuthFormShellProps> = ({
  titleKey,
  subtitleKey,
  icon,
  error,
  onDismissError,
  children,
}) => {
  const { t } = useI18n();

  return (
    <div>
      <div className="text-center mb-6">
        {icon && (
          <div className="mx-auto w-12 h-12 rounded-full bg-[var(--surface-field-bg)] text-[var(--surface-heading-fg)] flex items-center justify-center mb-4">
            {icon}
          </div>
        )}
        <h2 className="text-2xl font-bold text-[var(--surface-heading-fg)]">{t(titleKey)}</h2>
        {subtitleKey && (
          <p className="mt-1 text-sm text-[var(--surface-muted-fg)]">{t(subtitleKey)}</p>
        )}
      </div>

      {/* Single aria-live error slot — every auth form routes its error here. */}
      <div aria-live="polite">
        {error && (
          <Alert type="error" dismissible={!!onDismissError} onDismiss={onDismissError}>
            {error}
          </Alert>
        )}
      </div>

      {children}
    </div>
  );
};

export default AuthFormShell;
