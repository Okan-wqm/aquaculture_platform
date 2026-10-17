/**
 * useAccountLanguage — switch the interface language and save it on the
 * account (FE-HIGH-089).
 *
 * WHY one path: the language follows the user, not the device. The session
 * switches at once (setLocale also stores the device preference), then the
 * account's `preferredLanguage` is saved and the session reloaded — otherwise
 * UserLocaleSync would re-apply the old account language on the next load and
 * the choice would flip back. The settings page and the console's user menu
 * and palette all change the language through this hook.
 *
 * WHAT: an async function; it rejects when the account could not be saved
 * (the session keeps the new language), so each caller reports the failure
 * in its own surface.
 */
import {
  graphqlClient,
  useAuthContext,
  useI18n,
  type SupportedLocale,
} from '@aquaculture/shared-ui';
import { useCallback } from 'react';

import { UPDATE_MY_PROFILE } from '../graphql/settings.operations';

/** Switches the session language and saves it on the account; rejects when the save fails. */
export interface SaveAccountLanguage {
  (locale: SupportedLocale): Promise<void>;
}

export function useAccountLanguage(): SaveAccountLanguage {
  const { setLocale } = useI18n();
  const { refreshAuth } = useAuthContext();

  return useCallback(
    async (locale: SupportedLocale): Promise<void> => {
      setLocale(locale);
      await graphqlClient.request(UPDATE_MY_PROFILE, { input: { preferredLanguage: locale } });
      await refreshAuth();
    },
    [setLocale, refreshAuth],
  );
}
