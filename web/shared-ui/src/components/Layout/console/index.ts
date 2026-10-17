/**
 * The tenant console's shell components (design handoff "Tenant Console —
 * Industrial", phase 2). Each part adds its exports in its own block.
 */

// ── Console header (FE-HIGH-334): ConsoleHeader, TitleBlock, UserMenu, ViewAsBanner ──
export { ConsoleHeader, type ConsoleHeaderProps } from './ConsoleHeader';
export { TitleBlock, type TitleBlockProps } from './TitleBlock';
export { UserMenu, type UserMenuProps } from './UserMenu';
export { ViewAsBanner, type ViewAsBannerProps } from './ViewAsBanner';
export { deriveSheetCode, type SheetCodeSource } from './sheetCode';
export type {
  ConsoleDataStatus,
  ConsoleDeviceCounts,
  ConsoleSiteCounts,
  ConsoleTheme,
  UserMenuLink,
  UserMenuRole,
  UserMenuViewAs,
} from './headerTypes';

// ── Annunciator (FE-HIGH-334, README §7.5): the alarm strip and the shared
//    P1/P2/P3 scale + `?priority=` filter the alarm list reads ──
export {
  Annunciator,
  type AnnunciatorCounts,
  type AnnunciatorProps,
  type AnnunciatorStatus,
} from './Annunciator';
export {
  AnnunciatorGlyph,
  type AnnunciatorGlyphProps,
  type AnnunciatorGlyphTone,
} from './AnnunciatorGlyph';
export {
  ALARM_PRIORITIES,
  ALARM_PRIORITY_PARAM,
  ANNUNCIATOR_FILTERS,
  parseAnnunciatorFilter,
  priorityOf,
  severitiesOf,
  type AlarmPriority,
  type AnnunciatorFilter,
} from './AnnunciatorPriority';
export {
  ALARM_SEVERITIES,
  annunciatorScope,
  isOnTile,
  type AnnunciatorAlarm,
  type AnnunciatorScope,
} from './AnnunciatorScope';

// ── Command palette (FE-HIGH-334, README §8): the ⌘K dialog, its hotkey and
//    open state, the pure ranking, and the builders of its page and command
//    entries. The text folding stays internal: rankPalette is the one matcher,
//    so no caller can pre-filter a source by a rule of its own ──
export { CommandPalette, type CommandPaletteProps } from './CommandPalette';
export { isCommandPaletteHotkey, useCommandPaletteHotkey } from './CommandPaletteHotkey';
export { useCommandPaletteState, type CommandPaletteState } from './CommandPaletteState';
export {
  PALETTE_GROUP_LIMITS,
  PALETTE_SUGGESTED_PAGES,
  paletteNotices,
  paletteRows,
  rankPalette,
  type PaletteRow,
} from './CommandPaletteRank';
export {
  buildPaletteCommands,
  palettePagesFromNav,
  type PaletteCommandContext,
  type PaletteNavArea,
  type PaletteNavOptions,
  type PaletteNavPage,
  type PaletteNavTab,
} from './CommandPaletteSources';
export type {
  PaletteCommand,
  PaletteCommandEntry,
  PaletteEntry,
  PaletteGroupId,
  PaletteLinkEntry,
  PaletteNotice,
  PaletteRemoteSource,
  PaletteSection,
  PaletteSources,
} from './CommandPaletteTypes';

// ── Rail and workspace menu (README §7.2/§7.3): the labelled/icon rail, the
//    module switcher, the per-workspace alarm pairs, the rail's model types
//    and its icon vocabulary (the shell's ConsoleIcon / WorkspaceId) ──
export { IndustrialRail, type IndustrialRailProps } from './IndustrialRail';
export { WorkspaceMenu, type WorkspaceMenuProps } from './WorkspaceMenu';
export {
  AlarmPriorityCounts,
  type AlarmPriorityCountsProps,
  type AlarmPriorityTally,
} from './AlarmPriorityCounts';
export {
  CONSOLE_ICON_FALLBACK,
  CONSOLE_RAIL_ICONS,
  consoleIconFor,
  type ConsoleRailIconName,
} from './railIcons';
export { RAIL_AUTO_COLLAPSE_QUERY } from './useRailCollapsed';
export {
  CONSOLE_WORKSPACE_IDS,
  type ConsoleWorkspaceId,
  type RailActive,
  type RailArea,
  type RailBadgeCounts,
  type RailGroup,
  type RailPage,
  type RailTab,
  type RailWorkspace,
  type WorkspaceMenuEntry,
} from './railTypes';
