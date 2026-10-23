/**
 * GuardLoading — the guard family's default loading surface.
 *
 * WHAT: the BrandLoader (components/Loading, FE-MEDIUM-349), in the area the
 * guarded route stands in, announcing the session check
 * (guards.checkingSession). The layout around the route stays visible: a
 * guard is module altitude, not a full-screen takeover.
 *
 * WHY not a loader of its own: a session check used to read "Checking
 * session..." in grey text here while the shell drew a spinner and the
 * remotes their own fallbacks — the same wait in three looks. Every loading
 * screen is the one BrandLoader; the guard only names what it waits for.
 */

import React from 'react';

import { useI18n } from '../../i18n/I18nProvider';
import { BrandLoader } from '../Loading/BrandLoader';

export const GuardLoading: React.FC = () => {
  const { t } = useI18n();
  return <BrandLoader label={t('guards.checkingSession')} />;
};
