/**
 * Command palette — the types (FE-HIGH-334, design README §8).
 *
 * WHY plain data: the palette ranks and groups what it is handed, and that
 * ranking is a pure function the tests pin (CommandPaletteRank.ts). Where an
 * entry leads and what a command does belong to the shell — its routes, its
 * theme preference, its locale, its rail and workspace state — so an entry
 * carries a path or a typed command and nothing executable, and the shell's
 * `onSelect` is the one place either runs.
 *
 * WHAT: the entry kinds (link, command), the sources the palette reads
 * (pages and commands in hand, people and devices fetched with a status), and
 * the ranked sections it renders.
 */
import type { LucideIcon } from 'lucide-react';

import type { SupportedLocale } from '../../../i18n';

/** The result groups, each under its own heading. */
export type PaletteGroupId = 'pages' | 'people' | 'devices' | 'commands';

interface PaletteEntryBase {
  /** Unique within its group (a page's path, a person's id, a command's name). */
  readonly id: string;
  /** What the row shows and the query matches first. */
  readonly label: string;
  /** Right-aligned context: a page's area, a person's or a device's state. Shown, never matched. */
  readonly hint?: string;
  /**
   * More text the query matches: an area, group or workspace label, a parent
   * page, an English label, a device code.
   */
  readonly keywords?: readonly string[];
  /** The row's glyph; the group's default when absent. */
  readonly icon?: LucideIcon;
}

/** An entry that opens a route: a page, a page's tab, a person, a device. */
export interface PaletteLinkEntry extends PaletteEntryBase {
  readonly kind: 'link';
  readonly path: string;
  /**
   * A level-3 tab of a page. Searchable like any page, but never one of the
   * suggestions the palette lists before anything is typed.
   */
  readonly nested?: true;
}

/** What a console command asks the shell to do — each names its target state, so a run is idempotent. */
export type PaletteCommand<W extends string = string> =
  | { readonly type: 'theme'; readonly theme: 'light' | 'dark' }
  | { readonly type: 'language'; readonly locale: SupportedLocale }
  | { readonly type: 'rail'; readonly collapsed: boolean }
  | { readonly type: 'workspace'; readonly workspace: W };

/** An entry that runs a console command. */
export interface PaletteCommandEntry<W extends string = string> extends PaletteEntryBase {
  readonly kind: 'command';
  readonly command: PaletteCommand<W>;
}

export type PaletteEntry<W extends string = string> = PaletteLinkEntry | PaletteCommandEntry<W>;

/**
 * A fetched source (people, devices). Entries exist only when it is ready, so
 * a loading or failed source cannot render a stale or empty list as if it
 * were the answer; 'unavailable' is a source this viewer may not read.
 */
export type PaletteRemoteSource =
  | { readonly status: 'ready'; readonly entries: readonly PaletteLinkEntry[] }
  | { readonly status: 'loading' | 'error' | 'unavailable' };

/** Everything the palette searches. */
export interface PaletteSources<W extends string = string> {
  /** Pages and their tabs, in navigation order (CommandPaletteSources.palettePagesFromNav). */
  readonly pages: readonly PaletteLinkEntry[];
  /**
   * Paths of `pages` offered, in this order, before anything is typed — the
   * design's curated set. A path not among `pages` is skipped. Absent: the
   * first top-level pages (PALETTE_SUGGESTED_PAGES).
   */
  readonly suggested?: readonly string[];
  readonly people: PaletteRemoteSource;
  readonly devices: PaletteRemoteSource;
  /** The console commands (CommandPaletteSources.buildPaletteCommands). */
  readonly commands: readonly PaletteCommandEntry<W>[];
}

/** One rendered group: its heading and its ranked entries, never empty. */
export interface PaletteSection<W extends string = string> {
  readonly group: PaletteGroupId;
  readonly entries: readonly PaletteEntry<W>[];
}

/** A fetched source that is not answering the current query: still loading, or failed. */
export interface PaletteNotice {
  readonly group: 'people' | 'devices';
  readonly status: 'loading' | 'error';
}
