/**
 * UserLocaleSync — the account's language wins once the user is known.
 *
 * The provider resolves the device preference, then the browser, then
 * Turkish, before anyone signs in (FE-HIGH-089). When the session loads a
 * user whose account carries a supported `preferredLanguage`, this applies
 * it — so a choice made on one device follows the user to the next — and the
 * provider persists it as the device preference for the next cold start.
 *
 * It reacts to the ACCOUNT value changing, not to the locale differing from
 * it: the settings page switches the locale first and saves the account
 * second, and a sync keyed on the difference would flip the UI back in
 * between. Renders nothing.
 */

import { isSupportedLocale, useAuthContext, useI18n } from '@aquaculture/shared-ui';
import { useEffect, useRef } from 'react';

export const UserLocaleSync = (): null => {
  const { user } = useAuthContext();
  const { setLocale } = useI18n();
  const preferred = user?.preferredLanguage;
  const applied = useRef<string | null>(null);

  useEffect(() => {
    if (!isSupportedLocale(preferred) || applied.current === preferred) return;
    applied.current = preferred;
    setLocale(preferred);
  }, [preferred, setLocale]);

  return null;
};
