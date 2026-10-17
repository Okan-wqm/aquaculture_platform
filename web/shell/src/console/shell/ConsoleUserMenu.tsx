/**
 * ConsoleUserMenu — the header's account menu, wired to the shell
 * (FE-HIGH-334, design README §7.4/§8).
 *
 * WHAT: shared-ui's UserMenu with the signed-in user, the role being shown
 * (the previewed role's name while viewing as one), the role preview for
 * tenant admins (useViewAsMenu), the theme (the shell's theme preference,
 * read from what is applied) and the language (saved on the account, as the
 * settings page saves it), Profile and Settings, and sign-out — the layout's
 * own logout, which purges the tenant's query cache.
 */
import { UserMenu, useAuthContext, useI18n, type UserMenuLink } from '@aquaculture/shared-ui';
import { Settings, UserRound } from 'lucide-react';
import { useMemo, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAppliedTheme } from '../../hooks/useAppliedTheme';
import { useConsoleShell } from '../ConsoleShellContext';
import type { ViewAsRole } from '../data';
import type { ConsoleNavInput } from '../nav';

import { useConsoleLanguage } from './useConsoleLanguage';
import { useViewAsMenu } from './useViewAsMenu';

export interface ConsoleUserMenuProps {
  /** The signed-in user's own nav input (never the previewed role's). */
  readonly real: ConsoleNavInput;
  /** A role picked in the preview section, or null for the user's own view. */
  readonly onViewAs: (role: ViewAsRole | null) => void;
  readonly onSignOut: () => void;
}

export function ConsoleUserMenu({ real, onViewAs, onSignOut }: ConsoleUserMenuProps): ReactElement {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { user } = useAuthContext();
  const { viewAsRole } = useConsoleShell();
  const [theme, setTheme] = useAppliedTheme();
  const changeLanguage = useConsoleLanguage();
  const viewAs = useViewAsMenu(real, onViewAs);

  const email = user?.email ?? '';
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || email;
  const roleLabel = viewAsRole === null ? t(`console.role.${real.role}`) : viewAsRole.name;
  const links = useMemo(
    (): UserMenuLink[] => [
      {
        label: t('header.myProfile'),
        icon: <UserRound className="size-[18px] shrink-0" strokeWidth={1.5} aria-hidden="true" />,
        onClick: () => navigate('/settings/profile'),
      },
      {
        label: t('header.settings'),
        icon: <Settings className="size-[18px] shrink-0" strokeWidth={1.5} aria-hidden="true" />,
        onClick: () => navigate('/settings'),
      },
    ],
    [navigate, t],
  );

  return (
    <UserMenu
      name={name}
      email={email}
      roleLabel={roleLabel}
      viewAs={viewAs}
      theme={theme}
      onThemeChange={setTheme}
      onLocaleChange={changeLanguage}
      links={links}
      onSignOut={onSignOut}
    />
  );
}
