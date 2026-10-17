/**
 * ConsoleShellContext — the tenant console's own state (FE-HIGH-334; design
 * handoff README §9, digest §10.1/§11).
 *
 * WHAT: the workspace the rail shows (`ws`), the rail's collapse choice
 * (`navCollapsed`, null = the window decides), the command palette's open
 * state and query, and the role an admin is previewing (`viewAsRole`).
 *
 * WHY each lives where it does:
 *  - `ws` and `navCollapsed` survive a reload per tenant through the repo's
 *    one sanctioned per-tenant browser store (useTenantScopedStorage): keys
 *    are namespaced by tenant, nothing is written before a tenant resolves,
 *    and logout sweeps the namespace. A stored value is trusted only when it
 *    is one the console writes (storedPreferences.ts).
 *  - the palette's query resets on every open and close (shared-ui
 *    useCommandPaletteState), so every session starts empty;
 *  - the role preview is session state only: it is never persisted, and the
 *    server never sees it (viewAs.ts). A workspace chosen or followed while
 *    previewing is the preview's, kept apart from the admin's own and dropped
 *    when the preview ends (workspaceChoice.ts) — only the admin's own is
 *    stored, so no caller has to remember not to store it.
 *
 * The state is per tenant: the provider remounts its state for another tenant
 * rather than carrying one tenant's workspace or preview into the next.
 */
import {
  useAuth,
  useCommandPaletteState,
  useTenantScopedStorage,
  type ConsoleWorkspaceId,
} from '@aquaculture/shared-ui';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import type { ViewAsRole } from './data';
import {
  CONSOLE_NAV_COLLAPSED_STORAGE_KEY,
  CONSOLE_WS_STORAGE_KEY,
  parseStoredCollapsed,
  parseStoredWorkspace,
} from './shell/storedPreferences';
import { reduceWorkspaceChoice, shownWorkspace } from './shell/workspaceChoice';

export interface ConsoleShellValue {
  /**
   * The workspace last chosen or followed; null until there is one (the route
   * decides). While a role preview is open it is the preview's.
   */
  readonly ws: ConsoleWorkspaceId | null;
  /** Stored per tenant only outside a role preview. */
  readonly setWs: (ws: ConsoleWorkspaceId) => void;
  /** The reader's rail choice; null leaves it to the window (collapsed below 1100 px). */
  readonly navCollapsed: boolean | null;
  readonly setNavCollapsed: (collapsed: boolean) => void;
  readonly paletteOpen: boolean;
  /** Opening or closing starts the next palette session on an empty query. */
  readonly setPaletteOpen: (open: boolean) => void;
  readonly togglePalette: () => void;
  readonly paletteQuery: string;
  readonly setPaletteQuery: (query: string) => void;
  /** The tenant role an admin is previewing the console as; null = their own view. */
  readonly viewAsRole: ViewAsRole | null;
  readonly setViewAsRole: (role: ViewAsRole | null) => void;
}

const ConsoleShellContext = createContext<ConsoleShellValue | null>(null);

export interface ConsoleShellProviderProps {
  /** The tenant the stored choices belong to (`useAuth().tenantId`); null stores nothing. */
  readonly tenantId: string | null;
  readonly children: ReactNode;
}

export function ConsoleShellProvider({
  tenantId,
  children,
}: ConsoleShellProviderProps): ReactElement {
  // Keyed by tenant: another tenant starts from its own stored choices and no preview.
  return (
    <TenantConsoleState key={tenantId ?? ''} tenantId={tenantId}>
      {children}
    </TenantConsoleState>
  );
}

function TenantConsoleState({ tenantId, children }: ConsoleShellProviderProps): ReactElement {
  const wsStore = useTenantScopedStorage<unknown>(CONSOLE_WS_STORAGE_KEY, tenantId);
  const collapsedStore = useTenantScopedStorage<unknown>(
    CONSOLE_NAV_COLLAPSED_STORAGE_KEY,
    tenantId,
  );
  const [choice, dispatchChoice] = useReducer(reduceWorkspaceChoice, null, () => ({
    own: parseStoredWorkspace(wsStore.read()),
    preview: null,
    viewAsRole: null,
  }));
  const [navCollapsed, setCollapsedState] = useState(() =>
    parseStoredCollapsed(collapsedStore.read()),
  );
  const palette = useCommandPaletteState();

  const { own: ownWs, viewAsRole } = choice;
  const ws = shownWorkspace(choice);
  // What is stored is the admin's own workspace, whichever path changed it.
  useEffect(() => {
    if (ownWs !== null) wsStore.write(ownWs);
  }, [ownWs, wsStore]);

  const setWs = useCallback(
    (next: ConsoleWorkspaceId): void => dispatchChoice({ type: 'select', ws: next }),
    [],
  );
  const setViewAsRole = useCallback(
    (role: ViewAsRole | null): void => dispatchChoice({ type: 'viewAs', role }),
    [],
  );
  const setNavCollapsed = useCallback(
    (collapsed: boolean): void => {
      setCollapsedState(collapsed);
      collapsedStore.write(collapsed);
    },
    [collapsedStore],
  );
  const { openPalette, close: closePalette } = palette;
  const setPaletteOpen = useCallback(
    (open: boolean): void => (open ? openPalette() : closePalette()),
    [openPalette, closePalette],
  );

  const value = useMemo(
    (): ConsoleShellValue => ({
      ws,
      setWs,
      navCollapsed,
      setNavCollapsed,
      paletteOpen: palette.open,
      setPaletteOpen,
      togglePalette: palette.toggle,
      paletteQuery: palette.query,
      setPaletteQuery: palette.setQuery,
      viewAsRole,
      setViewAsRole,
    }),
    [ws, setWs, navCollapsed, setNavCollapsed, palette, setPaletteOpen, viewAsRole, setViewAsRole],
  );

  return <ConsoleShellContext.Provider value={value}>{children}</ConsoleShellContext.Provider>;
}

/** The console's state; only inside ConsoleShellProvider (the tenant console). */
export function useConsoleShell(): ConsoleShellValue {
  const value = useContext(ConsoleShellContext);
  if (value === null) {
    throw new Error('useConsoleShell must be used inside ConsoleShellProvider');
  }
  return value;
}

/** The provider for the signed-in tenant — what the console mounts. */
export function TenantConsoleShellProvider({ children }: { children: ReactNode }): ReactElement {
  const { tenantId } = useAuth();
  return <ConsoleShellProvider tenantId={tenantId}>{children}</ConsoleShellProvider>;
}
