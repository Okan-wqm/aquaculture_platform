/**
 * Command palette results (FE-HIGH-334, design README §8) — the grouped
 * listbox and the status line under it.
 *
 * WHY a listbox the input controls: focus stays in the search field while the
 * arrow keys move a highlight (aria-activedescendant), so the user can keep
 * typing; the rows are options, not buttons, and are reached by pointer or by
 * that highlight — never by Tab. The status line is a live region: it reads
 * the result count, "no results", and a people or device search still running
 * or failed, so an absent group never passes for "no match".
 */
import { Cpu, FileText, SquareTerminal, User, type LucideIcon } from 'lucide-react';
import React from 'react';

import { useI18n, type MessageKey } from '../../../i18n';

import type {
  PaletteEntry,
  PaletteGroupId,
  PaletteNotice,
  PaletteSection,
} from './CommandPaletteTypes';

const GROUP_LABEL: Record<PaletteGroupId, MessageKey> = {
  pages: 'console.palette.group.pages',
  people: 'console.palette.group.people',
  devices: 'console.palette.group.devices',
  commands: 'console.palette.group.commands',
};

/** The glyph of an entry that brings none of its own. */
const GROUP_ICON: Record<PaletteGroupId, LucideIcon> = {
  pages: FileText,
  people: User,
  devices: Cpu,
  commands: SquareTerminal,
};

const NOTICE: Record<PaletteNotice['group'], Record<PaletteNotice['status'], MessageKey>> = {
  people: { loading: 'console.palette.people.loading', error: 'console.palette.people.error' },
  devices: { loading: 'console.palette.devices.loading', error: 'console.palette.devices.error' },
};

const ROW = 'flex min-h-12 w-full cursor-pointer items-center gap-3.5 px-5 text-left';
const ROW_ACTIVE =
  'bg-sd-accent-100 text-sd-accent-900 shadow-[inset_3px_0_0_var(--color-sd-accent)]';

export interface CommandPaletteListProps<W extends string> {
  readonly listId: string;
  /** The DOM id of the row at a flat index (aria-activedescendant). */
  readonly optionId: (index: number) => string;
  readonly sections: readonly PaletteSection<W>[];
  readonly activeIndex: number;
  readonly onActivate: (index: number) => void;
  readonly onRun: (entry: PaletteEntry<W>) => void;
}

export function CommandPaletteList<W extends string>({
  listId,
  optionId,
  sections,
  activeIndex,
  onActivate,
  onRun,
}: CommandPaletteListProps<W>): React.ReactElement {
  const { t } = useI18n();
  // Each section's first flat index, so a row's id and highlight match the keyboard's list.
  const starts = sections.map((_, i) =>
    sections.slice(0, i).reduce((count, earlier) => count + earlier.entries.length, 0),
  );

  return (
    <div id={listId} role="listbox" aria-label={t('console.palette.results')}>
      {sections.map((section, s) => {
        const labelId = `${listId}-${section.group}`;
        return (
          <div key={section.group} role="group" aria-labelledby={labelId} className="py-1.5">
            <div
              id={labelId}
              role="presentation"
              className="px-5 py-2 text-[13px] font-bold uppercase tracking-[0.1em] text-sd-neutral-700"
            >
              {t(GROUP_LABEL[section.group])}
            </div>
            {section.entries.map((entry, e) => {
              const index = starts[s] + e;
              const active = index === activeIndex;
              const Icon = entry.icon ?? GROUP_ICON[section.group];
              return (
                // Rows are reached through the input's aria-activedescendant, so
                // they take no tab stop and keep focus in the field on press.
                <div
                  key={`${section.group}:${entry.id}`}
                  id={optionId(index)}
                  role="option"
                  aria-selected={active}
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => onActivate(index)}
                  onClick={() => onRun(entry)}
                  className={`${ROW} ${active ? ROW_ACTIVE : 'text-sd-ink'}`}
                >
                  <Icon className="size-[22px] shrink-0" strokeWidth={1.5} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-[17px]">{entry.label}</span>
                  {entry.hint !== undefined && (
                    <span className="max-w-[40%] shrink-0 truncate text-[15px] text-sd-neutral-700">
                      {entry.hint}
                    </span>
                  )}
                  {active && (
                    <kbd
                      aria-hidden="true"
                      className="shrink-0 border border-sd-accent px-2 py-0.5 font-display text-[13px] font-semibold text-sd-accent-800"
                    >
                      {t('console.palette.key.enter')} ↵
                    </kbd>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export interface CommandPaletteStatusProps {
  readonly query: string;
  readonly count: number;
  readonly notices: readonly PaletteNotice[];
}

/** The live status line: searches still running or failed, else "no results", else the count (read only). */
export function CommandPaletteStatus({
  query,
  count,
  notices,
}: CommandPaletteStatusProps): React.ReactElement {
  const { t } = useI18n();
  const nothing = count === 0 && notices.length === 0 && query.trim() !== '';
  return (
    <div role="status" className="text-[17px] text-sd-neutral-800">
      {notices.map((notice) => (
        <p key={notice.group} className="px-5 py-3 text-[15px]">
          {t(NOTICE[notice.group][notice.status])}
        </p>
      ))}
      {nothing && (
        <p className="p-7 text-center">{t('console.palette.empty', { query: query.trim() })}</p>
      )}
      {count > 0 && (
        <span className="sr-only">
          {count === 1
            ? t('console.palette.count.one')
            : t('console.palette.count.other', { count })}
        </span>
      )}
    </div>
  );
}
