/**
 * AdminConsole — the SUPER_ADMIN frame inside MainLayout: the admin Sidebar
 * (its own navigation, the phone overlay behind the hamburger) and the
 * shared Header over the neutral canvas. The tenant console never renders
 * here; tenant-side roles get console/ConsoleShell.
 */
import {
  Button,
  Header,
  Sidebar,
  useAuthContext,
  useI18n,
  usePageTitle,
  useTenantContext,
} from '@aquaculture/shared-ui';
import { Menu } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import { ActAsTenantBanner } from '../components/ActAsTenantBanner';

import {
  SUPER_ADMIN_NAVIGATION,
  activeNavigationLabel,
  localizeNavigation,
} from './adminNavigation';

/** The aside's id — the hamburger's `aria-controls` target. */
const SIDEBAR_ID = 'main-navigation';

/** The SUPER_ADMIN console's brand (a product name; the panel is a declared English-only surface). */
const ADMIN_LOGO_TEXT = 'Aqua Admin';

export interface AdminConsoleProps {
  /** The layout's header tools — notifications and the AI trigger. */
  readonly headerTools: React.ReactNode;
  readonly onLogout: () => void;
}

export function AdminConsole({ headerTools, onLogout }: AdminConsoleProps): React.ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuthContext();
  const { tenant } = useTenantContext();
  const { t } = useI18n();

  // The desktop column's rail mode, and the phone overlay (FE-HIGH-088 — below
  // md the column is off-canvas until the hamburger opens it).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const navigationItems = useMemo(() => localizeNavigation(SUPER_ADMIN_NAVIGATION, t), [t]);
  // The page's identity: the document title and the route announcement.
  usePageTitle(activeNavigationLabel(navigationItems, location.pathname));

  const handleSidebarToggle = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);

  const handleNavigate = useCallback(
    (path: string) => {
      navigate(path);
    },
    [navigate],
  );

  const userMenuItems = useMemo(
    () => [
      {
        label: t('header.myProfile'),
        onClick: () => navigate('/settings/profile'),
      },
      {
        label: t('header.settings'),
        onClick: () => navigate('/settings'),
      },
    ],
    [navigate, t],
  );

  const logoElement = useMemo(
    () => (
      <div className="flex items-center">
        <span className="text-xl font-bold text-primary-600 dark:text-primary-400">
          {ADMIN_LOGO_TEXT}
        </span>
      </div>
    ),
    [],
  );

  /**
   * Hamburger — phone widths only. It opens the Sidebar's overlay (the column
   * is off-canvas below md); the column's own toggle handles collapsing on
   * desktop.
   */
  const leftContent = useMemo(
    () => (
      <Button
        variant="ghost"
        iconOnly
        onClick={() => setMobileNavOpen(true)}
        aria-label={t('header.openNavigation')}
        aria-expanded={mobileNavOpen}
        aria-controls={SIDEBAR_ID}
        className="md:hidden text-gray-500 dark:text-gray-400"
      >
        <Menu className="w-6 h-6" aria-hidden="true" />
      </Button>
    ),
    [mobileNavOpen, t],
  );

  return (
    <>
      <Sidebar
        id={SIDEBAR_ID}
        items={navigationItems}
        activePath={location.pathname}
        collapsed={sidebarCollapsed}
        mobileOpen={mobileNavOpen}
        onMobileOpenChange={setMobileNavOpen}
        onNavigate={handleNavigate}
        onCollapsedChange={handleSidebarToggle}
        theme="admin"
        logo={logoElement}
        userRoles={['SUPER_ADMIN']}
      />

      <div className="flex-1 flex flex-col min-h-screen min-w-0">
        <Header
          user={user}
          tenant={tenant}
          userMenuItems={userMenuItems}
          onLogout={onLogout}
          theme="admin"
          leftContent={leftContent}
          rightContent={headerTools}
        />
        <ActAsTenantBanner />

        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 overflow-auto focus:outline-hidden p-4 md:p-6"
        >
          <Outlet />
        </main>
      </div>
    </>
  );
}
