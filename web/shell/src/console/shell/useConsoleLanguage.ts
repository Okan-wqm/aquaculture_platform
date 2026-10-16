/**
 * useConsoleLanguage — the language switch of the console's user menu and
 * command palette.
 *
 * WHY: both switch through the account path the settings page uses
 * (useAccountLanguage: the session at once, then the account, so the choice
 * does not flip back on the next load). Neither has a form to show a failure
 * in, so a failed save is reported as the settings page reports it — an
 * error toast — while the session keeps the new language.
 */
import {
  formatErrorForToast,
  useI18n,
  useToast,
  type SupportedLocale,
} from '@aquaculture/shared-ui';
import { useCallback } from 'react';

import { useAccountLanguage } from '../../hooks/useAccountLanguage';

export function useConsoleLanguage(): (locale: SupportedLocale) => void {
  const saveAccountLanguage = useAccountLanguage();
  const { toast } = useToast();
  const { t } = useI18n();

  return useCallback(
    (locale: SupportedLocale): void => {
      void saveAccountLanguage(locale).catch((error: unknown) => {
        toast({
          title: t('settings.language.failed'),
          description: formatErrorForToast(error),
          variant: 'error',
        });
      });
    },
    [saveAccountLanguage, toast, t],
  );
}
