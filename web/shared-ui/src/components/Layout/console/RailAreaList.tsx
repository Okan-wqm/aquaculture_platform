/**
 * RailAreaList — the expanded rail's accordion (digest §3.3–§3.6): area rows
 * (level 1) over their groups and pages (level 2), and the level-3 tabs of the
 * page the reader is on.
 *
 * WHAT: an area row toggles its body and carries the summed badge of its
 * pages while closed; the area holding the current page is drawn in the
 * accent. A page row is a link with its own badge and, for a routed "coming
 * soon" page, a "Planned" tag; the current page is `aria-current="page"` with
 * the accent fill and the 3 px inset bar. Under it, its tabs, the current one
 * `aria-current="true"` (the current item of that page's set).
 */
import { ChevronDown } from 'lucide-react';
import { useId, type ReactElement } from 'react';

import { useI18n } from '../../../i18n';

import { areaBadge, pageBadge } from './railBadges';
import { RailBadge } from './RailBadge';
import { RailLink } from './RailLink';
import { CONSOLE_RAIL_ICONS } from './railIcons';
import type { RailActive, RailArea, RailBadgeCounts, RailGroup, RailPage } from './railTypes';
import type { AreaDisclosure } from './useAreaDisclosure';

export interface RailNavigation {
  readonly active: RailActive | undefined;
  readonly badgeCounts: RailBadgeCounts;
  readonly onNavigate: (path: string) => void;
  readonly onItemHover?: (path: string) => void;
}

const ROW_FOCUS =
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sd-accent';

function PageTabs({
  page,
  navigation,
}: {
  page: RailPage;
  navigation: RailNavigation;
}): ReactElement | null {
  const tabs = page.tabs ?? [];
  if (tabs.length === 0) return null;
  const activeTab = navigation.active === undefined ? undefined : navigation.active.tabId;
  return (
    <ul
      aria-label={page.label}
      className="ml-2.5 flex flex-col gap-px border-l border-sd-rule pl-1.5"
    >
      {tabs.map((tab) => {
        const current = tab.id === activeTab;
        return (
          <li key={tab.id}>
            <RailLink
              href={tab.path}
              onNavigate={navigation.onNavigate}
              onHover={navigation.onItemHover}
              aria-current={current ? 'true' : undefined}
              className={`flex min-h-[38px] w-full items-center px-2.5 text-[14.5px] ${ROW_FOCUS} ${
                current
                  ? 'font-semibold text-sd-accent-900 shadow-[inset_2px_0_0_var(--color-sd-accent)]'
                  : 'text-sd-ink hover:bg-sd-neutral-200'
              }`}
            >
              {tab.label}
            </RailLink>
          </li>
        );
      })}
    </ul>
  );
}

function PageRow({
  page,
  navigation,
}: {
  page: RailPage;
  navigation: RailNavigation;
}): ReactElement {
  const { t } = useI18n();
  const current = navigation.active !== undefined && navigation.active.pageId === page.id;
  const badge = pageBadge(page, navigation.badgeCounts);
  return (
    <li className="flex flex-col gap-px">
      <RailLink
        href={page.path}
        onNavigate={navigation.onNavigate}
        onHover={navigation.onItemHover}
        aria-current={current ? 'page' : undefined}
        className={`flex min-h-11 w-full items-center gap-2.5 px-2.5 text-[15.5px] ${ROW_FOCUS} ${
          current
            ? 'bg-sd-accent-100 font-medium text-sd-accent-900 shadow-[inset_3px_0_0_var(--color-sd-accent)]'
            : 'text-sd-ink hover:bg-sd-neutral-200'
        }`}
      >
        <span className="min-w-0 flex-1">{page.label}</span>
        {page.status === 'planned' && (
          <span className="shrink-0 border border-sd-rule px-1.5 font-display-sd text-[11px] font-semibold uppercase leading-[18px] tracking-[0.08em] text-sd-neutral-700">
            {t('console.rail.planned')}
          </span>
        )}
        {badge > 0 && <RailBadge count={badge} placement="row" />}
      </RailLink>
      {current && <PageTabs page={page} navigation={navigation} />}
    </li>
  );
}

function GroupBlock({
  group,
  navigation,
}: {
  group: RailGroup;
  navigation: RailNavigation;
}): ReactElement {
  const titleId = useId();
  const titled = group.label !== undefined;
  return (
    <div
      role={titled ? 'group' : undefined}
      aria-labelledby={titled ? titleId : undefined}
      className="flex flex-col gap-px"
    >
      {titled && (
        <span
          id={titleId}
          className="px-2.5 pb-1 pt-2.5 text-xs font-bold uppercase tracking-[0.1em] text-sd-neutral-700"
        >
          {group.label}
        </span>
      )}
      <ul className="flex flex-col gap-px">
        {group.pages.map((page) => (
          <PageRow key={page.id} page={page} navigation={navigation} />
        ))}
      </ul>
    </div>
  );
}

function AreaItem({
  area,
  open,
  onToggle,
  navigation,
}: {
  area: RailArea;
  open: boolean;
  onToggle: () => void;
  navigation: RailNavigation;
}): ReactElement {
  const bodyId = useId();
  const Icon = CONSOLE_RAIL_ICONS[area.icon];
  const holdsCurrent = navigation.active !== undefined && navigation.active.areaId === area.id;
  const badge = areaBadge(area, navigation.badgeCounts);
  return (
    <li className="mb-0.5">
      <button
        type="button"
        data-rail-area={area.id}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className={`flex min-h-[50px] w-full items-center gap-3 px-3 text-left text-base hover:bg-sd-neutral-200 ${ROW_FOCUS} ${
          holdsCurrent ? 'font-medium text-sd-accent-800' : 'text-sd-ink'
        }`}
      >
        <Icon size={22} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1">{area.label}</span>
        {!open && badge > 0 && <RailBadge count={badge} placement="row" />}
        <ChevronDown
          size={16}
          strokeWidth={1.5}
          aria-hidden="true"
          className={`shrink-0 transition-transform duration-150 motion-reduce:transition-none ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      <div
        id={bodyId}
        hidden={!open}
        className="mb-2.5 ml-[22px] mt-0.5 flex flex-col gap-px border-l border-sd-rule pl-3"
      >
        {open &&
          area.groups.map((group) => (
            <GroupBlock key={group.id} group={group} navigation={navigation} />
          ))}
      </div>
    </li>
  );
}

export interface RailAreaListProps {
  readonly areas: readonly RailArea[];
  readonly disclosure: AreaDisclosure;
  readonly navigation: RailNavigation;
}

export function RailAreaList({ areas, disclosure, navigation }: RailAreaListProps): ReactElement {
  return (
    <ul className="flex flex-col">
      {areas.map((area) => (
        <AreaItem
          key={area.id}
          area={area}
          open={disclosure.isOpen(area.id)}
          onToggle={() => disclosure.toggle(area.id)}
          navigation={navigation}
        />
      ))}
    </ul>
  );
}
