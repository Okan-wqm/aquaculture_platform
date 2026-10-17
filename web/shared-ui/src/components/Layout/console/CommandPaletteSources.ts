/**
 * Command palette sources (FE-HIGH-334, design README §8) — pure builders for
 * the entries the palette is handed: pages from the console navigation model
 * and the console commands.
 *
 * WHY here and not in the shell: the shell owns the navigation model and the
 * state the commands change, but which page a tab entry names, which command
 * a toggle offers and how both read are palette rules — one owner, pinned by
 * the palette's tests. The navigation input is structural, so the shell's
 * built `Area[]` (web/shell/src/console/nav) is accepted as it is and shared-ui
 * does not import the shell.
 */
import {
  Languages,
  LayoutGrid,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  type LucideIcon,
} from 'lucide-react';

import {
  SUPPORTED_LOCALES,
  en,
  type I18nContextValue,
  type MessageKey,
  type SupportedLocale,
} from '../../../i18n';

import type { PaletteCommandEntry, PaletteLinkEntry } from './CommandPaletteTypes';

type Translate = I18nContextValue['t'];

// ── Pages ────────────────────────────────────────────────────────────────────

/** A page's in-page tab, as the console nav model builds it. */
export interface PaletteNavTab {
  readonly id: string;
  readonly label: string;
  /** The catalogue key `label` was translated from: the English label is matched too. */
  readonly labelKey?: MessageKey;
  readonly path: string;
}

/** A page, as the console nav model builds it. */
export interface PaletteNavPage {
  readonly id: string;
  readonly label: string;
  /** The catalogue key `label` was translated from: the English label is matched too. */
  readonly labelKey?: MessageKey;
  readonly path: string;
  readonly tabs?: readonly PaletteNavTab[];
}

/** An area (rail row) with its groups, as the console nav model builds it. */
export interface PaletteNavArea {
  readonly id: string;
  readonly label: string;
  readonly groups: readonly {
    readonly label?: string;
    readonly pages: readonly PaletteNavPage[];
  }[];
}

export interface PaletteNavOptions<A extends PaletteNavArea> {
  /** Text every entry also matches — the workspace's label, so "greenhouse feeding" finds it. */
  readonly context?: string;
  /** The glyph of an area's pages (the rail's icon for it); the group default when absent. */
  readonly iconOf?: (area: A) => LucideIcon;
}

/**
 * The English label of a page or tab read in another language (design: a
 * page "matches its localized label, English label or area label"), so a
 * Turkish reader typing "feeding" finds Yemleme. Nothing when the label is
 * English already, or names no catalogue key.
 */
function englishLabel(item: PaletteNavPage | PaletteNavTab): string[] {
  if (item.labelKey === undefined) return [];
  const english = en[item.labelKey];
  return english === item.label ? [] : [english];
}

/**
 * One entry per destination, in navigation order: each page, then its tabs
 * ("Feeding › Forecast", nested). A page listed in several areas, or a tab
 * that is its page's own path, leads to one route and is listed once — the
 * first time it appears. The hint shows the area; the area, the group, the
 * workspace, a tab's page and the English labels are what is matched besides
 * the label.
 */
export function palettePagesFromNav<A extends PaletteNavArea>(
  areas: readonly A[],
  options: PaletteNavOptions<A> = {},
): PaletteLinkEntry[] {
  const seen = new Set<string>();
  const entries: PaletteLinkEntry[] = [];
  const add = (entry: PaletteLinkEntry): void => {
    if (seen.has(entry.path)) return;
    seen.add(entry.path);
    entries.push(entry);
  };
  for (const area of areas) {
    const icon = options.iconOf ? { icon: options.iconOf(area) } : {};
    for (const group of area.groups) {
      const keywords = [area.label, group.label, options.context].filter(
        (text): text is string => text !== undefined,
      );
      for (const page of group.pages) {
        const pageEnglish = englishLabel(page);
        add({
          kind: 'link',
          id: page.path,
          path: page.path,
          label: page.label,
          hint: area.label,
          keywords: [...keywords, ...pageEnglish],
          ...icon,
        });
        for (const tab of page.tabs ?? []) {
          add({
            kind: 'link',
            id: tab.path,
            path: tab.path,
            label: `${page.label} › ${tab.label}`,
            hint: area.label,
            keywords: [...keywords, page.label, ...pageEnglish, ...englishLabel(tab)],
            nested: true,
            ...icon,
          });
        }
      }
    }
  }
  return entries;
}

// ── Commands ─────────────────────────────────────────────────────────────────

/** The console state the commands act on, read when the palette opens. */
export interface PaletteCommandContext<W extends string> {
  /** The theme on screen (a 'system' preference already resolved). */
  readonly theme: 'light' | 'dark';
  readonly locale: SupportedLocale;
  /** Whether the rail is collapsed on screen. */
  readonly railCollapsed: boolean;
  /** The workspaces this viewer can open, labelled, in switcher order. */
  readonly workspaces: readonly { readonly id: W; readonly label: string }[];
  readonly currentWorkspace: W | undefined;
}

/**
 * The console commands (README §8: theme, language, rail; plus the workspace
 * switch the module menu offers). Each toggle offers the state the console is
 * not in, and the workspace switch every workspace but the current one.
 */
export function buildPaletteCommands<W extends string>(
  context: PaletteCommandContext<W>,
  t: Translate,
): PaletteCommandEntry<W>[] {
  const nextTheme = context.theme === 'dark' ? 'light' : 'dark';
  const commands: PaletteCommandEntry<W>[] = [
    {
      kind: 'command',
      id: 'theme',
      label: t(
        nextTheme === 'dark'
          ? 'console.palette.command.themeDark'
          : 'console.palette.command.themeLight',
      ),
      icon: nextTheme === 'dark' ? Moon : Sun,
      command: { type: 'theme', theme: nextTheme },
    },
  ];
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === context.locale) continue;
    commands.push({
      kind: 'command',
      id: `language:${locale}`,
      label: t('console.palette.command.language', { language: t(`language.${locale}`) }),
      icon: Languages,
      command: { type: 'language', locale },
    });
  }
  commands.push({
    kind: 'command',
    id: 'rail',
    label: t(
      context.railCollapsed
        ? 'console.palette.command.railExpand'
        : 'console.palette.command.railCollapse',
    ),
    keywords: [t('console.palette.command.railKeywords')],
    icon: context.railCollapsed ? PanelLeftOpen : PanelLeftClose,
    command: { type: 'rail', collapsed: !context.railCollapsed },
  });
  for (const workspace of context.workspaces) {
    if (workspace.id === context.currentWorkspace) continue;
    commands.push({
      kind: 'command',
      id: `workspace:${workspace.id}`,
      label: t('console.palette.command.workspace', { workspace: workspace.label }),
      keywords: [t('console.palette.command.workspaceKeywords')],
      icon: LayoutGrid,
      command: { type: 'workspace', workspace: workspace.id },
    });
  }
  return commands;
}
