/**
 * Main Layout — the frame of every authenticated page.
 *
 * Two consoles share it (FE-HIGH-334):
 *  - SUPER_ADMIN keeps the admin console: its Sidebar and the shared Header
 *    over the neutral canvas (AdminConsole);
 *  - every tenant-side role gets the tenant console (console/ConsoleShell):
 *    the Industrial rail and workspace menu, the console header with the
 *    command palette, title block, user menu and annunciator, over the
 *    `.sd-content` column, its navigation built from the console nav model.
 *
 * Both carry what the layout owns itself: the skip link, the account-language
 * sync, the notifications and AI assistant in the header, the consent banner,
 * and sign-out with the tenant cache purge (useShellLogout).
 */

import { Button, SkipToContent, useAuth, useAuthContext, useI18n } from '@aquaculture/shared-ui';
import { Sparkles } from 'lucide-react';
import React, { useMemo, useState } from 'react';

import { NotificationPanel } from '@/components/NotificationPanel';

import AiAssistantDrawer from '../components/ai/AiAssistantDrawer';
import ConsentBanner from '../components/ConsentBanner';
import { UserLocaleSync } from '../components/UserLocaleSync';
import { ConsoleShell } from '../console/ConsoleShell';
import { useShellLogout } from '../hooks/useShellLogout';

import { AdminConsole } from './AdminConsole';

const MainLayout: React.FC = () => {
  const { user } = useAuthContext();
  const { t } = useI18n();
  // hasPermission is the resource-permission SSoT (useAuthContext exposes only
  // roles); gates the AI assistant trigger by ai_assistant:use.
  const { hasPermission } = useAuth();
  const signOut = useShellLogout();
  const userRole = user?.role;

  // AI assistant drawer (shell-level, accessible from every module).
  const [aiDrawerOpen, setAiDrawerOpen] = useState(false);
  const canUseAiAssistant = hasPermission('ai_assistant:use');

  /**
   * The header's tools in both consoles: the AI assistant trigger and the
   * self-contained notification bell with its dropdown. The trigger's hover
   * colour has a dark step: primary-600 on the dark ghost hover fill was
   * about 2:1, under the 3:1 an icon needs (WCAG 1.4.11).
   */
  const headerTools = useMemo(
    () => (
      <div className="flex items-center gap-1">
        {canUseAiAssistant && (
          <Button
            variant="ghost"
            iconOnly
            onClick={() => setAiDrawerOpen(true)}
            title={t('header.aiAssistant')}
            aria-label={t('header.openAiAssistant')}
            className="text-gray-500 hover:text-primary-600 dark:text-gray-400 dark:hover:text-primary-300"
          >
            <Sparkles className="h-5 w-5" />
          </Button>
        )}
        <NotificationPanel />
      </div>
    ),
    [canUseAiAssistant, t],
  );

  const isSuperAdmin = userRole === 'SUPER_ADMIN';

  return (
    <div
      className={`min-h-screen flex ${isSuperAdmin ? 'bg-gray-50 dark:bg-gray-800' : 'bg-sd-paper'}`}
    >
      <SkipToContent />
      <UserLocaleSync />
      {userRole === 'SUPER_ADMIN' ? (
        <AdminConsole headerTools={headerTools} onLogout={signOut} />
      ) : (
        // ProtectedRoute admits only a signed-in user, so a role is always present here.
        userRole !== undefined && (
          <ConsoleShell role={userRole} headerTools={headerTools} onSignOut={signOut} />
        )
      )}

      {/* GDPR Consent Banner — shown when consent is outdated or missing */}
      <ConsentBanner />

      {canUseAiAssistant && (
        <AiAssistantDrawer open={aiDrawerOpen} onClose={() => setAiDrawerOpen(false)} />
      )}
    </div>
  );
};

export default MainLayout;
