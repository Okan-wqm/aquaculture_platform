/**
 * Command palette ranking (FE-HIGH-334, design README §8) — pure.
 *
 * WHY one function: the rows the palette draws, the row the arrow keys move
 * over and the row Enter runs must be the same list. The prototype filtered
 * its rendered rows by role but indexed the unfiltered list on Enter, so a
 * restricted user could run a row other than the highlighted one; deriving
 * the sections once, here, and flattening them for the keyboard makes that
 * impossible.
 *
 * WHY the only matcher: the shell hands people and devices over unfiltered,
 * so every group — pages, people, devices, commands — is found by this one
 * rule. A second matcher upstream would drop rows this one finds ("kaya
 * fehmi" for Fehmi Kaya) before they ever reached it.
 *
 * WHAT: foldForSearch (case- and accent-blind text), rankPalette (sections in
 * display order, ranked and capped) and paletteNotices (fetched sources not
 * answering yet).
 *
 * Before anything is typed the palette offers the commands, then the pages
 * the caller suggests (the design's curated set), else the first top-level
 * pages of the navigation it was given. With a query it lists pages, people,
 * devices, then commands, each ranked: the whole label, the label's start, a
 * word's start, anywhere in the label, a keyword, then every word of the
 * query somewhere — the given order between equals. The hint is never
 * matched: it is what a row shows (a person's online state, say), not what
 * the row is found by.
 */
import type {
  PaletteEntry,
  PaletteGroupId,
  PaletteLinkEntry,
  PaletteNotice,
  PaletteRemoteSource,
  PaletteSection,
  PaletteSources,
} from './CommandPaletteTypes';

/** Rows a group shows at most for a query; commands are few and all shown. */
export const PALETTE_GROUP_LIMITS: Readonly<Record<Exclude<PaletteGroupId, 'commands'>, number>> = {
  pages: 6,
  people: 5,
  devices: 4,
};

/** Top-level pages offered before anything is typed when the caller suggests none. */
export const PALETTE_SUGGESTED_PAGES = 6;

const COMBINING_MARKS = /\p{M}/gu;
const WORD_START = /[^\p{L}\p{N}]/u;
const WHITESPACE = /\s+/;

/**
 * Letters NFKD leaves whole — no base letter plus a mark to drop — written as
 * the base letters a reader without them on the keyboard types. Lower case
 * only: the fold lowers before it maps.
 */
const BASE_LETTERS: Readonly<Record<string, string>> = {
  ı: 'i',
  ø: 'o',
  æ: 'ae',
  œ: 'oe',
  đ: 'd',
  ł: 'l',
  ß: 'ss',
};
const WHOLE_LETTERS = new RegExp(`[${Object.keys(BASE_LETTERS).join('')}]`, 'gu');

/**
 * Lower case without diacritics, so the user can type without them: a plain
 * toLowerCase() leaves "İlker" as "i̇lker" (i plus a combining dot) and keeps
 * ş and å distinct, so "ilker" or "sahin" would miss. NFKD splits the marks
 * off and they are dropped; the letters it cannot split (dotless ı, ø, æ, …)
 * become their base letters, so "bjorn" finds Bjørn as "agard" finds Ågård.
 */
export function foldForSearch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(WHOLE_LETTERS, (letter) => BASE_LETTERS[letter] ?? letter);
}

const SCORE = {
  whole: 6,
  labelStart: 5,
  wordStart: 4,
  inLabel: 3,
  inKeyword: 2,
  everyWord: 1,
  none: 0,
} as const;

/** `needle` occurs in `text` at the start of a word. */
function atWordStart(text: string, needle: string): boolean {
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    if (at === 0 || WORD_START.test(text[at - 1])) return true;
  }
  return false;
}

/** How well an entry answers a folded, non-empty query (SCORE.none: not at all). */
function score(entry: PaletteEntry, needle: string, words: readonly string[]): number {
  const label = foldForSearch(entry.label);
  if (label === needle) return SCORE.whole;
  if (label.startsWith(needle)) return SCORE.labelStart;
  if (atWordStart(label, needle)) return SCORE.wordStart;
  if (label.includes(needle)) return SCORE.inLabel;
  const keywords = (entry.keywords ?? []).map(foldForSearch);
  if (keywords.some((text) => text.includes(needle))) return SCORE.inKeyword;
  const everyWord =
    words.length > 1 &&
    words.every((word) => label.includes(word) || keywords.some((text) => text.includes(word)));
  return everyWord ? SCORE.everyWord : SCORE.none;
}

/** The matching entries, best first, the given order between equals, at most `limit`. */
function rank<E extends PaletteEntry>(
  entries: readonly E[],
  needle: string,
  words: readonly string[],
  limit: number,
): E[] {
  return entries
    .map((entry, order) => ({ entry, order, score: score(entry, needle, words) }))
    .filter((hit) => hit.score > SCORE.none)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((hit) => hit.entry);
}

function readyEntries(source: PaletteRemoteSource): PaletteSources['pages'] {
  return source.status === 'ready' ? source.entries : [];
}

function nonEmpty<W extends string>(sections: PaletteSection<W>[]): PaletteSection<W>[] {
  return sections.filter((section) => section.entries.length > 0);
}

/** The query folded, trimmed and with single spaces; '' when nothing is typed. */
function needleOf(query: string): string {
  return foldForSearch(query).trim().split(WHITESPACE).join(' ');
}

/**
 * The pages offered before anything is typed: the caller's suggestions, each
 * once and in its order, else the first top-level pages. Only a page the
 * palette was handed can be suggested, so a suggestion never leads anywhere
 * a typed search could not.
 */
function suggestedPages(sources: PaletteSources): PaletteLinkEntry[] {
  if (sources.suggested === undefined) {
    return sources.pages.filter((entry) => !entry.nested).slice(0, PALETTE_SUGGESTED_PAGES);
  }
  const byPath = new Map(sources.pages.map((entry) => [entry.path, entry]));
  return [...new Set(sources.suggested)].flatMap((path) => byPath.get(path) ?? []);
}

/** The sections the palette renders for `query`, in display order, none empty. */
export function rankPalette<W extends string>(
  sources: PaletteSources<W>,
  query: string,
): PaletteSection<W>[] {
  const needle = needleOf(query);
  if (needle === '') {
    return nonEmpty<W>([
      { group: 'commands', entries: sources.commands },
      { group: 'pages', entries: suggestedPages(sources) },
    ]);
  }
  const words = needle.split(' ');
  return nonEmpty<W>([
    { group: 'pages', entries: rank(sources.pages, needle, words, PALETTE_GROUP_LIMITS.pages) },
    {
      group: 'people',
      entries: rank(readyEntries(sources.people), needle, words, PALETTE_GROUP_LIMITS.people),
    },
    {
      group: 'devices',
      entries: rank(readyEntries(sources.devices), needle, words, PALETTE_GROUP_LIMITS.devices),
    },
    {
      group: 'commands',
      entries: rank(sources.commands, needle, words, sources.commands.length),
    },
  ]);
}

/** One row of the rendered list, in the order the arrow keys walk it. */
export interface PaletteRow<W extends string = string> {
  /** Stable across re-ranking: the group and the entry's id. */
  readonly key: string;
  readonly group: PaletteGroupId;
  readonly entry: PaletteEntry<W>;
}

/** The sections flattened in display order — the one list rows, arrow keys and Enter share. */
export function paletteRows<W extends string>(
  sections: readonly PaletteSection<W>[],
): PaletteRow<W>[] {
  return sections.flatMap((section) =>
    section.entries.map((entry) => ({
      key: `${section.group}:${entry.id}`,
      group: section.group,
      entry,
    })),
  );
}

/**
 * The fetched sources not answering `query`: still loading, or failed. The
 * palette says so instead of letting an absent group read as "no match".
 * Nothing before a query is typed (people and devices are not listed then)
 * and nothing for a source this viewer cannot read.
 */
export function paletteNotices(sources: PaletteSources, query: string): PaletteNotice[] {
  if (needleOf(query) === '') return [];
  const notices: PaletteNotice[] = [];
  for (const group of ['people', 'devices'] as const) {
    const { status } = sources[group];
    if (status === 'loading' || status === 'error') notices.push({ group, status });
  }
  return notices;
}
