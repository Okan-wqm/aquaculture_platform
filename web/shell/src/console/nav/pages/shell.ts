/**
 * Console pages served by the shell itself and by the auth-only remotes
 * (dashboard, messaging): every tenant role reaches them, no module gate.
 */
import { AI_ASSISTANT_USE_CAPABILITY } from '@aquaculture/shared-contracts';

import type { NavPageDef } from '../types';

import { pathTabs } from './tabs';

export const SHELL_PAGES = {
  // Each module workspace opens on a dashboard of its own (the dashboard
  // remote's pages): Production's site status at /dashboard, Control &
  // sensors' at /dashboard/control, Greenhouse's at /dashboard/greenhouse.
  // One label — the palette and the title name the workspace beside it.
  dashboard: { id: 'dashboard', labelKey: 'nav.dashboard', path: '/dashboard' },
  controlDashboard: {
    id: 'dashboard-control',
    labelKey: 'nav.dashboard',
    path: '/dashboard/control',
  },
  greenhouseDashboard: {
    id: 'dashboard-greenhouse',
    labelKey: 'nav.dashboard',
    path: '/dashboard/greenhouse',
  },
  // Cross-module trends (harvest, sensor, farm distribution). Replaces the
  // module users' dead `/analytics` link, which no route served.
  dashboardAnalytics: {
    id: 'dashboard-analytics',
    labelKey: 'nav.page.trendsAnalytics',
    path: '/dashboard/analytics',
  },
  messaging: {
    id: 'messaging',
    labelKey: 'nav.messages',
    path: '/messaging',
    matchPaths: ['/messaging/:channelId'],
  },
  // The page refuses a viewer without the AI surface capability
  // (NewAiChatPage `canUseAi`), and the channel list shows its button only to
  // holders (FE-MEDIUM-065), so the nav offers it on the same gate.
  newAiChat: {
    id: 'messaging-new-ai',
    labelKey: 'nav.page.newAiChat',
    path: '/messaging/new-ai',
    requiredPermission: AI_ASSISTANT_USE_CAPABILITY,
  },
  // The account's own settings; the header menu opens the same routes.
  profile: {
    id: 'profile',
    labelKey: 'nav.page.profile',
    path: '/settings/profile',
    tabs: pathTabs('/settings', [
      ['profile', 'nav.tab.profile'],
      ['security', 'nav.security'],
      ['preferences', 'nav.tab.preferences'],
      ['privacy', 'nav.tab.privacy'],
    ]),
  },
} satisfies Record<string, NavPageDef>;
