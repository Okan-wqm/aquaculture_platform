/**
 * UserMenuPanel — the user menu's content (README §7.4), top to bottom:
 * name and e-mail · "View as role" (admins) · language and theme · the
 * account links · sign out. Every section is a 1px-ruled band on the panel's
 * paper; the panel itself (frame, elevation, Escape, outside press, focus) is
 * the shared Popover's console surface.
 *
 * WHY callbacks only: the language must also be saved on the account — the
 * shell's UserLocaleSync re-applies the account language on the next load —
 * and the theme goes through the shell's theme preference, so the panel
 * reports the choice and the shell carries it out. Links and sign out close
 * the panel first, so focus returns to the trigger before the route changes.
 */
import { LogOut } from 'lucide-react';
import { useId, type ReactElement } from 'react';

import { SUPPORTED_LOCALES, useI18n, type SupportedLocale } from '../../../i18n';

import type { ConsoleTheme, UserMenuLink, UserMenuViewAs } from './headerTypes';
import { SegmentGroup, type SegmentOption } from './SegmentGroup';
import { ViewAsRoleList } from './ViewAsRoleList';

export interface UserMenuPanelProps {
  readonly name: string;
  readonly email: string;
  readonly viewAs?: UserMenuViewAs;
  readonly theme: ConsoleTheme;
  readonly onThemeChange: (theme: ConsoleTheme) => void;
  readonly onLocaleChange: (locale: SupportedLocale) => void;
  readonly links: readonly UserMenuLink[];
  readonly onSignOut: () => void;
  /** Closes the panel (from the Popover). */
  readonly close: () => void;
}

/** The repo's locales by code, so English precedes Türkçe as in the design. */
const LANGUAGE_ORDER: readonly SupportedLocale[] = [...SUPPORTED_LOCALES].sort();

const ROW_FOCUS =
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sd-accent';

export function UserMenuPanel({
  name,
  email,
  viewAs,
  theme,
  onThemeChange,
  onLocaleChange,
  links,
  onSignOut,
  close,
}: UserMenuPanelProps): ReactElement {
  const { t, locale } = useI18n();
  const id = useId();
  const languageId = `${id}-language`;
  const themeId = `${id}-theme`;

  const languages: SegmentOption<SupportedLocale>[] = LANGUAGE_ORDER.map((code) => ({
    value: code,
    label: t(`language.${code}`),
  }));
  const themes: SegmentOption<ConsoleTheme>[] = [
    { value: 'dark', label: t('console.userMenu.themeDark') },
    { value: 'light', label: t('console.userMenu.themeLight') },
  ];

  return (
    <>
      <div className="flex flex-col gap-0.5 border-b border-sd-rule px-[20.4px] py-[13.6px]">
        <p className="m-0 text-base font-semibold text-sd-ink">{name}</p>
        <p className="m-0 truncate text-sm text-sd-neutral-700">{email}</p>
      </div>

      {viewAs !== undefined && viewAs.roles.length > 0 && (
        <ViewAsRoleList {...viewAs} onPicked={close} />
      )}

      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-3 border-b border-sd-rule px-[20.4px] py-[13.6px]">
        <span id={languageId} className="text-[14.5px] font-semibold text-sd-ink">
          {t('console.userMenu.language')}
        </span>
        <SegmentGroup
          labelledBy={languageId}
          options={languages}
          value={locale}
          onChange={onLocaleChange}
        />
        <span id={themeId} className="text-[14.5px] font-semibold text-sd-ink">
          {t('console.userMenu.theme')}
        </span>
        <SegmentGroup
          labelledBy={themeId}
          options={themes}
          value={theme}
          onChange={onThemeChange}
        />
      </div>

      {links.length > 0 && (
        <div className="flex flex-col border-b border-sd-rule py-[6.8px]">
          {links.map((link) => (
            <button
              key={link.label}
              type="button"
              onClick={() => {
                close();
                link.onClick();
              }}
              className={`flex min-h-[46px] items-center gap-3 px-[20.4px] text-left text-[15px] text-sd-ink hover:bg-sd-neutral-200 ${ROW_FOCUS}`}
            >
              {link.icon}
              <span>{link.label}</span>
            </button>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => {
          close();
          onSignOut();
        }}
        className={`flex min-h-[50px] items-center gap-2 px-[20.4px] text-left font-display-sd text-[15.5px] font-semibold text-sd-accent-700 hover:bg-sd-accent-100 ${ROW_FOCUS}`}
      >
        <LogOut aria-hidden="true" className="size-[18px] shrink-0" strokeWidth={1.5} />
        {t('header.logout')}
      </button>
    </>
  );
}
