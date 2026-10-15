/**
 * GuardLoading — the guard family's default loading surface.
 *
 * A light, module-level "checking session" state (the layout around the route
 * stays visible), NOT a full-screen takeover: `PageLoading` (components/Loading)
 * is the full-screen variant the shell uses at top-level routes. Keeping the
 * two surfaces distinct is deliberate — same family, different altitude.
 *
 * Restored from aria-karantina/kapsam-iadesi (dalga3-15) with the i18n
 * delta: the visible string renders from the shared-ui locale SSOT
 * (guards.checkingSession) instead of a hardcoded literal (FE-HIGH-089).
 */

import React from 'react';
import { useI18n } from '../../i18n/I18nProvider';

export const GuardLoading: React.FC = () => {
  const { t } = useI18n();
  return (
    <div
      className="flex h-48 items-center justify-center text-sm text-gray-500 dark:text-gray-400"
      role="status"
      aria-live="polite"
    >
      {t('guards.checkingSession')}
    </div>
  );
};
