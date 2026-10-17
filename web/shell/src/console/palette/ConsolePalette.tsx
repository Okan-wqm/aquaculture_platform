/**
 * ConsolePalette — the console's ⌘K command palette, wired to the shell
 * (FE-HIGH-334, design README §8).
 *
 * WHAT: shared-ui's CommandPalette and its hotkey, fed with the pages of the
 * nav on screen (the previewed role's while viewing as one) and the curated
 * ones it suggests, the people and devices a page of that nav can open
 * (usePaletteSources, fetched whole only while open — the palette's ranking
 * is the one matcher), and the console commands — theme, language, rail,
 * workspace. A link navigates; a command runs here. The open state and query
 * are the console's (ConsoleShellContext), so the header trigger and the
 * hotkey share them.
 */
import {
  CommandPalette,
  RAIL_AUTO_COLLAPSE_QUERY,
  buildPaletteCommands,
  useCommandPaletteHotkey,
  useI18n,
  type PaletteEntry,
  type PaletteSources,
} from '@aquaculture/shared-ui';
import { useCallback, useMemo, type ReactElement } from 'react';

import { useAppliedTheme } from '../../hooks/useAppliedTheme';
import { useConsoleShell } from '../ConsoleShellContext';
import { usePaletteSources } from '../data';
import type { Workspace, WorkspaceId } from '../nav';
import { useConsoleLanguage } from '../shell/useConsoleLanguage';

import {
  devicePathFor,
  devicesSource,
  hasPage,
  palettePages,
  paletteSuggestions,
  peopleSource,
  runPaletteCommand,
} from './paletteEntries';

export interface ConsolePaletteProps {
  /** The nav on screen: what the rail shows. */
  readonly workspaces: readonly Workspace[];
  readonly currentWorkspace: WorkspaceId | undefined;
  readonly onNavigate: (path: string) => void;
  /** Switch the rail to a workspace and open its home (the module menu's action). */
  readonly onSelectWorkspace: (id: WorkspaceId) => void;
}

/** Whether the rail is collapsed on screen: the reader's choice, else the window's. */
function railCollapsedOnScreen(preference: boolean | null): boolean {
  return preference ?? window.matchMedia(RAIL_AUTO_COLLAPSE_QUERY).matches;
}

export function ConsolePalette({
  workspaces,
  currentWorkspace,
  onNavigate,
  onSelectWorkspace,
}: ConsolePaletteProps): ReactElement {
  const { t, locale } = useI18n();
  const shell = useConsoleShell();
  const { paletteOpen, paletteQuery, setPaletteOpen, setPaletteQuery, navCollapsed } = shell;
  const [theme, setTheme] = useAppliedTheme();
  const changeLanguage = useConsoleLanguage();
  useCommandPaletteHotkey(shell.togglePalette);

  const devicePath = useMemo(() => devicePathFor(workspaces), [workspaces]);
  const reach = useMemo(
    () => ({ people: hasPage(workspaces, 'tenant-users'), devices: devicePath !== null }),
    [workspaces, devicePath],
  );
  const remote = usePaletteSources(paletteOpen, reach);

  const pages = useMemo(
    () => (paletteOpen ? palettePages(workspaces, currentWorkspace) : []),
    [paletteOpen, workspaces, currentWorkspace],
  );
  const suggested = useMemo(
    () => paletteSuggestions(workspaces, currentWorkspace),
    [workspaces, currentWorkspace],
  );
  const commands = useMemo(
    () =>
      paletteOpen
        ? buildPaletteCommands(
            {
              theme,
              locale,
              railCollapsed: railCollapsedOnScreen(navCollapsed),
              workspaces,
              currentWorkspace,
            },
            t,
          )
        : [],
    [paletteOpen, theme, locale, navCollapsed, workspaces, currentWorkspace, t],
  );
  const sources = useMemo(
    (): PaletteSources<WorkspaceId> => ({
      pages,
      suggested,
      people: peopleSource(remote.people, t),
      devices: devicesSource(remote.devices, devicePath, t),
      commands,
    }),
    [pages, suggested, remote.people, remote.devices, devicePath, commands, t],
  );

  const handleSelect = useCallback(
    (entry: PaletteEntry<WorkspaceId>): void => {
      if (entry.kind === 'link') {
        onNavigate(entry.path);
        return;
      }
      runPaletteCommand(entry.command, {
        theme: setTheme,
        language: changeLanguage,
        rail: shell.setNavCollapsed,
        workspace: onSelectWorkspace,
      });
    },
    [onNavigate, setTheme, changeLanguage, shell.setNavCollapsed, onSelectWorkspace],
  );
  const handleClose = useCallback(() => setPaletteOpen(false), [setPaletteOpen]);

  return (
    <CommandPalette<WorkspaceId>
      open={paletteOpen}
      onClose={handleClose}
      query={paletteQuery}
      onQueryChange={setPaletteQuery}
      sources={sources}
      onSelect={handleSelect}
    />
  );
}
