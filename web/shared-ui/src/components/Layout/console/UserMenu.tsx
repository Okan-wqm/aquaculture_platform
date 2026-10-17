/**
 * UserMenu — the console header's account control (README §7.4, §8).
 *
 * WHAT: the trigger — a 46px initials plate, the name and the role being
 * shown (from a console width of 980px, capped at 180px and truncated, as the
 * header row cannot shrink the menu), the language badge and a chevron in a
 * 1px rule frame — opening the user-menu panel (UserMenuPanel) as a
 * non-modal dialog, 360px wide or the console width less both header
 * gutters, whichever is smaller.
 *
 * WHERE the panel opens: under the trigger, aligned to its right edge, while
 * the header row holds one line — the trigger is then its last item. Where
 * the row wraps (console width ≤ 820px) the trigger can start a later line,
 * and a panel on its right edge ran off the console's left edge (and under
 * the rail). There it hangs from the header instead, right at the header's
 * gutter (`--sd-header-gutter`) — the Popover's `header-gutter` anchor, which
 * the notification bell beside it uses too.
 *
 * WHY on the shared Popover: Escape and an outside press close it, focus
 * moves in on open and back to the trigger on close (FE-HIGH-085), and it
 * needs no fixed overlay — which inside the header's `backdrop-filter` would
 * only cover the header. Presentational: every value and every choice is the
 * shell's (see UserMenuPanel for why the language and theme are callbacks).
 */
import { ChevronDown } from 'lucide-react';
import type { ReactElement } from 'react';

import { useI18n, type SupportedLocale } from '../../../i18n';
import { Popover, type PopoverTriggerProps } from '../../Menu';

import type { ConsoleTheme, UserMenuLink, UserMenuViewAs } from './headerTypes';
import { initialsOf } from './initials';
import { UserMenuPanel } from './UserMenuPanel';

export interface UserMenuProps {
  readonly name: string;
  readonly email: string;
  /** The label of the role the console is showing (the previewed one while viewing as). */
  readonly roleLabel: string;
  /** Admins only: the roles to view the console as. Omit to leave the section out. */
  readonly viewAs?: UserMenuViewAs;
  /** The resolved theme: `dark` = Control room, `light` = Drawing. */
  readonly theme: ConsoleTheme;
  /** The shell persists and applies it (persistThemePreference). */
  readonly onThemeChange: (theme: ConsoleTheme) => void;
  /**
   * The shell switches the locale AND saves it on the account — the account
   * language wins on the next load (UserLocaleSync), so switching only the
   * device would flip back.
   */
  readonly onLocaleChange: (locale: SupportedLocale) => void;
  /** Account links under the preferences (Profile, Settings). */
  readonly links?: readonly UserMenuLink[];
  readonly onSignOut: () => void;
}

export function UserMenu({
  name,
  email,
  roleLabel,
  viewAs,
  theme,
  onThemeChange,
  onLocaleChange,
  links = [],
  onSignOut,
}: UserMenuProps): ReactElement {
  const { t, locale } = useI18n();

  // A render function, not a component: the Popover's trigger props carry
  // its ref, which must land on the <button>.
  const renderTrigger = (props: PopoverTriggerProps): ReactElement => (
    <button
      {...props}
      type="button"
      aria-label={t('console.userMenu.trigger', { name })}
      className="flex min-h-14 items-center gap-[10.2px] border border-sd-rule bg-transparent py-1 pl-1 pr-3 text-left text-sd-ink transition-colors hover:bg-sd-neutral-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sd-accent motion-reduce:transition-none"
    >
      <span
        aria-hidden="true"
        className="grid size-[46px] shrink-0 place-items-center border border-sd-accent-300 bg-sd-accent-100 font-display-sd text-base font-semibold text-sd-accent-800"
      >
        {initialsOf(name, email, locale)}
      </span>
      <span className="hidden min-w-0 max-w-[180px] flex-col leading-[1.25] @min-[980px]/page:flex">
        <span className="truncate text-[15px] font-medium">{name}</span>
        <span className="truncate text-[13.5px] text-sd-neutral-700">{roleLabel}</span>
      </span>
      <span className="border border-sd-neutral-400 px-1.5 py-0.5 font-display-sd text-[13px] font-semibold tracking-[0.08em] text-sd-neutral-800">
        {locale.toUpperCase()}
      </span>
      <ChevronDown
        aria-hidden="true"
        strokeWidth={1.5}
        className={`size-4 shrink-0 transition-transform motion-reduce:transition-none ${
          props['aria-expanded'] ? 'rotate-180' : ''
        }`}
      />
    </button>
  );

  return (
    <Popover
      aria-label={t('header.userMenu')}
      surface="console"
      align="end"
      anchor="header-gutter"
      className="shrink-0"
      panelClassName="flex max-h-[calc(100vh-120px)] w-[360px] flex-col overflow-y-auto"
      trigger={renderTrigger}
    >
      {(close) => (
        <UserMenuPanel
          name={name}
          email={email}
          viewAs={viewAs}
          theme={theme}
          onThemeChange={onThemeChange}
          onLocaleChange={onLocaleChange}
          links={links}
          onSignOut={onSignOut}
          close={close}
        />
      )}
    </Popover>
  );
}
