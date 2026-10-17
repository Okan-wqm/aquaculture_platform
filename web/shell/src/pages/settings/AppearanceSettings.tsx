/**
 * AppearanceSettings — the settings page's theme card (Preferences tab).
 *
 * WHAT: light, dark or system, with the theme on screen under them.
 *
 * WHY it holds no theme state: the console's user menu and palette change the
 * theme from every page, this one included. The card reads the preference
 * and the applied theme from the one store they all write (useThemePreference
 * over utils/theme.ts), so the pressed option is always the one on screen,
 * whichever surface chose it. Following the OS colour scheme belongs to the
 * app (installed at boot), not to this card.
 *
 * Each option is a shared-ui Button toggle (`aria-pressed`), the pressed one
 * on the primary variant and the others on secondary, and every word on the
 * card comes from the message maps, so the card follows the user's language.
 */
import { Button, Card, type MessageKey, useI18n } from '@aquaculture/shared-ui';
import { SwatchBook } from 'lucide-react';
import React from 'react';

import { useThemePreference } from '../../hooks/useThemePreference';
import type { ThemePreference } from '../../utils/theme';

export interface AppearanceSettingsProps {
  showToast: (options: {
    title: string;
    description?: string;
    variant?: 'success' | 'error' | 'warning' | 'info';
  }) => void;
}

const THEME_OPTIONS: ReadonlyArray<{ id: ThemePreference; label: MessageKey }> = [
  { id: 'light', label: 'settings.appearance.light' },
  { id: 'dark', label: 'settings.appearance.dark' },
  { id: 'system', label: 'settings.appearance.system' },
];

export function AppearanceSettings({ showToast }: AppearanceSettingsProps): React.ReactElement {
  const { t } = useI18n();
  const { preference, resolved, setPreference } = useThemePreference();

  const updateThemePreference = (next: ThemePreference): void => {
    setPreference(next);
    showToast({
      title: t('settings.appearance.saved'),
      description: t('settings.appearance.savedDescription'),
      variant: 'success',
    });
  };

  return (
    <Card>
      <div className="p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-primary-100 dark:bg-primary-900/40 rounded-lg flex items-center justify-center">
            <SwatchBook
              className="w-5 h-5 text-primary-600 dark:text-primary-400"
              strokeWidth={1.5}
              aria-hidden="true"
            />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('settings.appearance.title')}
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('settings.appearance.description')}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-md">
          {THEME_OPTIONS.map((theme) => {
            const pressed = preference === theme.id;
            return (
              <Button
                key={theme.id}
                variant={pressed ? 'primary' : 'secondary'}
                fullWidth
                aria-pressed={pressed}
                onClick={() => updateThemePreference(theme.id)}
              >
                {t(theme.label)}
              </Button>
            );
          })}
        </div>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-3">
          {t('settings.appearance.current', {
            theme: t(
              resolved === 'dark' ? 'settings.appearance.dark' : 'settings.appearance.light',
            ),
          })}
        </p>
      </div>
    </Card>
  );
}
