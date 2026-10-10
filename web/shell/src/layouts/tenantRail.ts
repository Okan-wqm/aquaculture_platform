/**
 * The tenant console rail's sections (FE-HIGH-313).
 *
 * The shell's navigation is one flat list per role; the Suderra rail groups
 * it — Overview, People & access, Modules, Communication, Account — and
 * gives each entry an icon from the rail's own set. Grouping only places
 * items: every item the role's list carries keeps its route, and an item the
 * grouping does not name is still placed (under its module, or appended to
 * Account), so the rail can never hide a page the flat list showed.
 */
import type {
  I18nContextValue,
  NavigationItem,
  SuderraNavSection,
  SuderraRailIconName,
} from '@aquaculture/shared-ui';

/** Rail icons for top-level entries, keyed by nav id. */
const ITEM_ICONS: Readonly<Record<string, SuderraRailIconName>> = {
  company: 'building',
  'tenant-dashboard': 'gauge',
  dashboard: 'gauge',
  messaging: 'chat',
  'tenant-users': 'users',
  'tenant-roles': 'shield',
  'tenant-activity': 'pulse',
  'tenant-modules': 'blocks',
  'tenant-communication': 'comms',
  'tenant-messages': 'mail',
  'tenant-support': 'lifebuoy',
  'tenant-announcements': 'megaphone',
  'tenant-devices': 'drive',
  'tenant-database': 'database',
  'tenant-audit-log': 'scroll',
  'tenant-billing': 'card',
  'tenant-settings': 'sliders',
  'farm-module': 'waves',
  'sensor-module': 'signal',
  'hr-module': 'contact',
  'hydroponics-module': 'wheat',
  analytics: 'linechart',
  reports: 'report',
};

/** Rail icons for module menu entries, keyed by nav id. */
const CHILD_ICONS: Readonly<Record<string, SuderraRailIconName>> = {
  'sites-environment': 'thermo',
  'sites-setup': 'wrench',
  'sites-tanks': 'droplet',
  'sites-feeding': 'wheat',
  'sites-feeding-records': 'report',
  'sites-water-chemistry': 'ph',
  'sites-storage': 'warehouse',
  'sites-tasks': 'checks',
  'sites-health': 'lifebuoy',
  'sites-maintenance': 'wrench',
  'sites-harvest': 'basket',
  'sites-reports': 'bars',
  'sites-finance': 'card',
  'sites-analytics': 'linechart',
  'sensor-dashboard': 'gauge',
  'sensor-devices': 'chip',
  'sensor-readings': 'linechart',
  'sensor-alerts': 'bell',
  'sensor-automation': 'workflow',
  'sensor-water-chemistry': 'ph',
  'sensor-plc': 'chip',
  'sensor-plc-connections': 'network',
  'sensor-plc-feeding': 'wheat',
  'sensor-plc-alarms': 'bell',
  'sensor-processes': 'network',
  'sensor-scada': 'expand',
  'hr-dashboard': 'gauge',
  'hr-employees': 'users',
  'hr-departments': 'contact',
  'hr-scheduling': 'calendar',
  'hr-crew': 'users',
  'hr-attendance': 'clock',
  'hr-leaves': 'calendar',
  'hr-training': 'contact',
  'hr-payroll': 'banknote',
  'hr-finance': 'card',
  'hydroponics-setup': 'wrench',
  'hydroponics-general': 'sliders',
  'hydroponics-water': 'droplet',
  'hydroponics-user': 'user',
  'hydroponics-result': 'linechart',
  'hydroponics-pid-sim': 'workflow',
};

function withRailIcons(items: NavigationItem[]): NavigationItem[] {
  return items.map((item) => ({
    ...item,
    icon: ITEM_ICONS[item.id] ?? item.icon,
    children: item.children?.map((child) => ({
      ...child,
      icon: CHILD_ICONS[child.id] ?? child.icon,
    })),
  }));
}

export interface TenantRailInput {
  /** The role's own entries (TENANT_ADMIN base list, or the module user's base list plus delegated tenant entries), localized */
  entries: NavigationItem[];
  /** One entry per assigned module, localized; no divider */
  modules: NavigationItem[];
  isTenantAdmin: boolean;
  t: I18nContextValue['t'];
}

const OVERVIEW_ADMIN = ['company', 'tenant-dashboard', 'messaging'];
const OVERVIEW_USER = ['company', 'dashboard', 'messaging', 'analytics', 'reports'];
const PEOPLE = ['tenant-users', 'tenant-roles', 'tenant-activity'];
const COMMUNICATION = [
  'tenant-communication',
  'tenant-messages',
  'tenant-support',
  'tenant-announcements',
];
const ACCOUNT = [
  'tenant-devices',
  'tenant-database',
  'tenant-audit-log',
  'tenant-billing',
  'tenant-settings',
];

export function buildTenantRailSections({
  entries,
  modules,
  isTenantAdmin,
  t,
}: TenantRailInput): SuderraNavSection[] {
  const placed = new Set<string>();
  const pick = (ids: readonly string[]): NavigationItem[] =>
    ids.flatMap((id) => {
      const item = entries.find((entry) => entry.id === id);
      if (!item || placed.has(id)) return [];
      placed.add(id);
      return [item];
    });

  const overview = pick(isTenantAdmin ? OVERVIEW_ADMIN : OVERVIEW_USER);
  const people = pick(PEOPLE);
  const moduleEntries = [...pick(['tenant-modules']), ...modules];
  // The communication group's children are the section's entries.
  const communication = pick(COMMUNICATION).flatMap((item) => item.children ?? [item]);
  const account = pick(ACCOUNT);
  // Anything the grouping does not name still reaches the rail.
  const rest = entries.filter((entry) => !placed.has(entry.id));

  const sections: SuderraNavSection[] = [
    { id: 'sec-overview', label: t('nav.overview'), items: overview },
    { id: 'sec-people', label: t('nav.section.people'), items: people },
    { id: 'sec-modules', label: t('nav.modules'), items: moduleEntries },
    { id: 'sec-comms', label: t('nav.communication'), items: communication },
    { id: 'sec-account', label: t('nav.section.account'), items: [...account, ...rest] },
  ];

  return sections
    .map((section) => ({ ...section, items: withRailIcons(section.items) }))
    .filter((section) => section.items.length > 0);
}
