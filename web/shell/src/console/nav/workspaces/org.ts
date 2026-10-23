/**
 * Company (org) — consolidated finance, workforce, facility and the account;
 * tenant-admin, HR and the company record (design WSN `org`). No module gates
 * the workspace itself: it appears for anyone with an entry to show.
 *
 * Beyond the design tree: an Overview area — the company dashboard, which
 * every tenant user opens (an admin sees the account's cards, anyone else the
 * notices meant for them), and messages, so a tenant with HR alone — no module
 * workspace — keeps a home; the module dashboards live in their own
 * workspaces — the HR pages no nav reached before
 * (team overview, scheduling settings, rotations, certifications, the routed
 * "coming soon" placeholders as planned), finance charts and categories, and
 * the setup departments and workers tabs.
 */
import { FARM_OPERATION_PAGES as OPS } from '../pages/farmOperations';
import { FARM_SETUP_PAGES as SETUP } from '../pages/farmSetup';
import { FINANCE_PAGES as FIN } from '../pages/finance';
import { HR_PAGES as HR, HR_PLANNED_PAGES } from '../pages/hr';
import { SHELL_PAGES } from '../pages/shell';
import { TENANT_PAGES as TN } from '../pages/tenant';
import type { WorkspaceDef } from '../types';

import { financeArea } from './shared';

export const ORG_WORKSPACE: WorkspaceDef = {
  id: 'org',
  labelKey: 'nav.workspace.org',
  descriptionKey: 'nav.workspace.org.description',
  accentToken: '--color-sd-ws-org',
  areas: [
    {
      id: 'org-home',
      labelKey: 'nav.overview',
      icon: 'gauge',
      groups: [
        {
          id: 'org-home-main',
          pages: [TN.dashboard, SHELL_PAGES.messaging, SHELL_PAGES.newAiChat],
        },
      ],
    },
    financeArea('org-finance', [
      FIN.overview,
      FIN.expenses,
      FIN.budget,
      FIN.costCentres,
      FIN.charts,
      FIN.categories,
      FIN.settings,
    ]),
    {
      id: 'org-workforce',
      labelKey: 'nav.area.workforce',
      icon: 'users',
      groups: [
        {
          id: 'org-workforce-main',
          // Company is the all-modules view of the same people and
          // organisation pages the module workspaces scope to their module; a
          // tenant holding HR alone reaches the organization chart only here.
          pages: [HR.dashboard, HR.today, HR.employees, HR.departments, HR.organizationChart],
        },
        {
          id: 'org-time',
          labelKey: 'nav.group.timeShifts',
          pages: [HR.scheduling, HR.teamOverview, HR.attendance, HR.leaves, HR.schedulingSettings],
        },
        { id: 'org-crew', labelKey: 'nav.crew', pages: [HR.crew, HR.rotations] },
        {
          id: 'org-development',
          labelKey: 'nav.group.development',
          pages: [HR.training, HR.certifications, HR.performance],
        },
        {
          id: 'org-pay',
          labelKey: 'nav.group.payAnalysis',
          pages: [HR.payroll, FIN.hrFinance, HR.analytics],
        },
        {
          id: 'org-planned',
          labelKey: 'nav.group.planned',
          pages: Object.values(HR_PLANNED_PAGES),
        },
      ],
    },
    {
      id: 'org-facility',
      labelKey: 'nav.area.facility',
      icon: 'building-2',
      groups: [
        {
          id: 'org-facility-main',
          pages: [
            SETUP.company,
            SETUP.sites,
            OPS.storageLocations,
            SETUP.departments,
            SETUP.workers,
            SETUP.facilityStructure,
          ],
        },
        {
          id: 'org-purchasing',
          labelKey: 'nav.group.purchasing',
          pages: [SETUP.suppliers, SETUP.consumables],
        },
      ],
    },
    {
      id: 'org-account',
      labelKey: 'nav.section.account',
      icon: 'shield-check',
      groups: [
        {
          id: 'org-access',
          labelKey: 'nav.group.access',
          pages: [TN.users, TN.roles, TN.activity, TN.auditLog, TN.devices, TN.database],
        },
        {
          id: 'org-communication',
          labelKey: 'nav.communication',
          pages: [TN.messages, TN.support, TN.announcements],
        },
        {
          id: 'org-configuration',
          labelKey: 'nav.configuration',
          pages: [TN.modules, TN.billing, TN.settings, SHELL_PAGES.profile],
        },
        {
          id: 'org-platform',
          labelKey: 'nav.platform',
          pages: [TN.architecture, TN.architectureReview],
        },
      ],
    },
  ],
};
