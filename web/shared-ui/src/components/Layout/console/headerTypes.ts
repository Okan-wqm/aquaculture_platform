/**
 * Shapes the console header's presentational parts (title block, user menu)
 * take from the shell.
 *
 * WHY declared here and not imported from the shell: shared-ui does not
 * depend on the shell. The count shapes mirror the shell's console data hooks
 * (`web/shell/src/console/data`: StatusResult — real values when 'ready',
 * every value null otherwise), so the shell passes a hook's result straight
 * through, and a cell can only show a number its query returned.
 */
import type { ReactNode } from 'react';

/** loading: first fetch in flight · ready: real data · error: the latest fetch failed · unavailable: not for this viewer. */
export type ConsoleDataStatus = 'loading' | 'ready' | 'error' | 'unavailable';

type NotReady = Exclude<ConsoleDataStatus, 'ready'>;

/** Sites with a live edge device out of the viewer's active sites (shell useSiteStatus). */
export type ConsoleSiteCounts =
  | { readonly status: 'ready'; readonly live: number; readonly total: number }
  | { readonly status: NotReady; readonly live: null; readonly total: null };

/** Edge devices online out of all (shell useDeviceStatus). */
export type ConsoleDeviceCounts =
  | { readonly status: 'ready'; readonly online: number; readonly total: number }
  | { readonly status: NotReady; readonly online: null; readonly total: null };

/** The two console themes: Drawing is the light one, Control room the dark one. */
export type ConsoleTheme = 'light' | 'dark';

/** A role the user menu offers to view the console as (admins only). */
export interface UserMenuRole {
  readonly id: string;
  /** The role's name as the tenant set it, or its localized system label. */
  readonly label: string;
  /** How many console pages the role can open, as the shell's nav model counts them. */
  readonly pageCount: number;
}

/** The "view as role" section: the roles, the one the console shows, and the pick. */
export interface UserMenuViewAs {
  readonly roles: readonly UserMenuRole[];
  /** The role the console is showing — the user's own when not previewing; null presses none. */
  readonly activeRoleId: string | null;
  /** The shell switches the view (client-side only; mutations keep the real role, README §8). */
  readonly onViewAs: (roleId: string) => void;
}

/** An account link under the preferences (today's Profile and Settings). */
export interface UserMenuLink {
  readonly label: string;
  readonly icon?: ReactNode;
  readonly onClick: () => void;
}
