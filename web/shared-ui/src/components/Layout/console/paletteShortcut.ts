/**
 * The command palette's shortcut as the header shows it (README §7.4,
 * decision D12): ⌘K on Apple platforms, Ctrl+K elsewhere.
 *
 * WHY per platform: the palette opens on `metaKey || ctrlKey` + K, but a key
 * cap reading ⌘ on Windows or Linux names a key the keyboard does not have.
 * The modifier's face is a message key like every other visible string
 * (FE-HIGH-089); `aria-keyshortcuts` gives assistive technology the same
 * shortcut in the spec's own spelling.
 */
import type { MessageKey } from '../../../i18n';

export interface PaletteShortcut {
  /** The modifier key cap's message. */
  readonly modifierKey: MessageKey;
  /** The `aria-keyshortcuts` value of the trigger. */
  readonly ariaKeyShortcuts: 'Meta+K' | 'Control+K';
}

const APPLE_PLATFORM = /Mac|iPhone|iPad|iPod/;

/** The shortcut for a user agent; pass `navigator.userAgent` (undefined outside a browser). */
export function paletteShortcut(userAgent: string | undefined): PaletteShortcut {
  return userAgent !== undefined && APPLE_PLATFORM.test(userAgent)
    ? { modifierKey: 'console.header.paletteKeyMac', ariaKeyShortcuts: 'Meta+K' }
    : { modifierKey: 'console.header.paletteKeyCtrl', ariaKeyShortcuts: 'Control+K' };
}
