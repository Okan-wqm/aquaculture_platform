/**
 * PaletteTrigger — the command palette's button in the console header
 * (README §7.4).
 *
 * WHAT: a blueprint-framed field look-alike (`sd-corners`: the four "+"
 * registration marks) with the search icon, the placeholder and the shortcut
 * key caps. It opens nothing itself: `onOpen` asks the shell, which owns the
 * palette and its ⌘K / Ctrl+K listener.
 *
 * WHY a button and not an input: typing happens in the palette dialog, which
 * has the listbox semantics; a header input would be a second search field
 * with none. The accessible name is the placeholder the button shows
 * (WCAG 2.5.3), `aria-keyshortcuts` carries the shortcut, and the key caps
 * are hidden from assistive technology so they are not read twice.
 *
 * Below a console width of 821px the trigger keeps its place after the
 * heading (no `order`: focus follows the lines as drawn, WCAG 2.4.3). It
 * shrinks to 240px and grows into the line, so it sits beside the heading
 * where both fit and fills a line of its own where they do not.
 */
import { Search } from 'lucide-react';
import type { ReactElement } from 'react';

import { useI18n } from '../../../i18n';

import { paletteShortcut } from './paletteShortcut';

export interface PaletteTriggerProps {
  readonly onOpen: () => void;
  /** Whether the palette is open, for `aria-expanded`. */
  readonly open?: boolean;
}

const KEY_CAP =
  'grid h-[30px] min-w-[30px] place-items-center border border-sd-neutral-400 bg-sd-paper px-1.5 font-display-sd text-sm font-semibold not-italic text-sd-neutral-800';

export function PaletteTrigger({ onOpen, open = false }: PaletteTriggerProps): ReactElement {
  const { t } = useI18n();
  const shortcut = paletteShortcut(
    typeof navigator === 'undefined' ? undefined : navigator.userAgent,
  );
  const placeholder = t('console.header.palettePlaceholder');

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={placeholder}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-keyshortcuts={shortcut.ariaKeyShortcuts}
      className="sd-corners mx-auto flex h-[54px] min-w-[200px] max-w-[680px] flex-[1_1_520px] cursor-pointer items-center gap-[10.2px] border border-sd-rule bg-sd-paper py-0 pl-4 pr-3 text-left text-[16.5px] text-sd-neutral-800 transition-colors hover:border-sd-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sd-accent motion-reduce:transition-none @max-[821px]/page:m-0 @max-[821px]/page:h-12 @max-[821px]/page:max-w-none @max-[821px]/page:flex-[1_1_240px]"
    >
      <Search aria-hidden="true" className="size-[22px] shrink-0" strokeWidth={1.5} />
      <span className="min-w-0 flex-1 truncate">{placeholder}</span>
      <span aria-hidden="true" className="flex shrink-0 gap-1">
        <kbd className={KEY_CAP}>{t(shortcut.modifierKey)}</kbd>
        <kbd className={KEY_CAP}>{t('console.header.paletteKeyK')}</kbd>
      </span>
    </button>
  );
}
