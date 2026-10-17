/**
 * CommandPalette — the console's ⌘K search (FE-HIGH-334, design README §8,
 * handoff digest "shell-header" §8).
 *
 * WHAT: a modal dialog with one search field over grouped results — pages
 * (with their tabs), people, devices and console commands. The arrow keys
 * move the highlight, Enter runs it, a click runs the row clicked; every run
 * closes the palette and hands the entry to `onSelect`, where the shell
 * navigates or runs the command.
 *
 * WHY the shared dialog behaviour and not Modal: Modal is a centred titled
 * card; the palette is a top-anchored, untitled Industry sheet (blueprint
 * corners, square, 820px). It takes everything else from the one dialog
 * primitive Modal and Drawer use — Escape, the Tab trap, scroll lock, focus
 * back to the opener (useDialogBehavior) — and, like Modal, portals to <body>
 * with the backdrop as a sibling BEFORE the positioned panel, so the backdrop
 * can never paint over it (the FARM-HIGH-129 class). Nothing is mounted while
 * closed, so every session starts on the first row.
 */
import { Search } from 'lucide-react';
import React, { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';

import { useI18n } from '../../../i18n';
import { useDialogBehavior } from '../../Modal/useDialogBehavior';

import { useActiveRow } from './CommandPaletteActive';
import { CommandPaletteList, CommandPaletteStatus } from './CommandPaletteList';
import { paletteNotices, paletteRows, rankPalette } from './CommandPaletteRank';
import type { PaletteEntry, PaletteSources } from './CommandPaletteTypes';

export interface CommandPaletteProps<W extends string = string> {
  readonly open: boolean;
  /** Escape, a backdrop click, and every run call it (useCommandPaletteState().close). */
  readonly onClose: () => void;
  /** Controlled, so the shell can match people and devices to it (usePaletteSources). */
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly sources: PaletteSources<W>;
  /** A link entry → navigate to its path; a command entry → run its command. Called after onClose. */
  readonly onSelect: (entry: PaletteEntry<W>) => void;
}

export function CommandPalette<W extends string = string>({
  open,
  ...dialog
}: CommandPaletteProps<W>): React.ReactElement | null {
  return open ? <CommandPaletteDialog {...dialog} /> : null;
}

/** The open palette: mounted only while open, so each session starts fresh. */
function CommandPaletteDialog<W extends string>({
  onClose,
  query,
  onQueryChange,
  sources,
  onSelect,
}: Omit<CommandPaletteProps<W>, 'open'>): React.ReactElement {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listId = `${baseId}-results`;
  const optionId = useCallback((index: number): string => `${listId}-${index}`, [listId]);

  useDialogBehavior({ isOpen: true, onClose, closeOnEscape: true, containerRef: panelRef });
  // useDialogBehavior focuses the panel on a zero timeout; this one is queued
  // after it (effects run in order), so the caret ends up in the field.
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);

  const sections = useMemo(() => rankPalette(sources, query), [sources, query]);
  const notices = useMemo(() => paletteNotices(sources, query), [sources, query]);
  const rows = useMemo(() => paletteRows(sections), [sections]);
  const keys = useMemo(() => rows.map((row) => row.key), [rows]);
  const active = useActiveRow(keys);
  const activeId = active.index === -1 ? undefined : optionId(active.index);

  useEffect(() => {
    if (activeId === undefined) return;
    document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const run = (entry: PaletteEntry<W>): void => {
    onClose();
    onSelect(entry);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      active.move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter' && active.index !== -1) {
      event.preventDefault();
      run(rows[active.index].entry);
    }
  };

  // The trigger's text (PaletteTrigger): the field the user clicked is the one that opens.
  const placeholder = t('console.header.palettePlaceholder');
  return createPortal(
    <div className="fixed inset-0 z-70 flex items-start justify-center px-5 pt-4 pb-5">
      <div className="fixed inset-0 bg-sd-scrim/45" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('console.palette.title')}
        tabIndex={-1}
        className="sd-surface sd-corners relative mt-3 flex max-h-[84vh] w-full max-w-[820px] flex-col border border-sd-rule bg-sd-paper text-sd-ink shadow-(--shadow-sd-lg) outline-none"
      >
        <div className="flex h-[72px] shrink-0 items-center gap-2.5 border-b border-sd-rule px-5 focus-within:shadow-[inset_0_-2px_0_var(--color-sd-accent)]">
          <Search
            className="size-6 shrink-0 text-sd-accent-700"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label={placeholder}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              // Every edit starts over at the first row (README §8: typing resets the index).
              active.reset();
              onQueryChange(event.target.value);
            }}
            onKeyDown={onKeyDown}
            className="h-[68px] min-w-0 flex-1 border-0 bg-transparent font-sans text-[21px] text-sd-ink outline-none placeholder:text-sd-neutral-700"
          />
          <kbd className="shrink-0 border border-sd-neutral-400 px-[7px] py-0.5 font-display text-[13px] font-semibold text-sd-neutral-800">
            {t('console.palette.key.escape')}
          </kbd>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
          <CommandPaletteList
            listId={listId}
            optionId={optionId}
            sections={sections}
            activeIndex={active.index}
            onActivate={active.activate}
            onRun={run}
          />
          <CommandPaletteStatus query={query} count={rows.length} notices={notices} />
        </div>
        <div className="flex shrink-0 flex-wrap gap-5 border-t border-sd-rule px-5 py-2.5 text-[15px] text-sd-neutral-800">
          <span>
            <kbd className="font-display font-semibold">↑ ↓</kbd> {t('console.palette.footer.move')}
          </span>
          <span>
            <kbd className="font-display font-semibold">{t('console.palette.key.enter')}</kbd>{' '}
            {t('console.palette.footer.open')}
          </span>
          <span>
            <kbd className="font-display font-semibold">{t('console.palette.key.escape')}</kbd>{' '}
            {t('console.palette.footer.close')}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
