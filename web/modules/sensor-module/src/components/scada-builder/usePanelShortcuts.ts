/**
 * usePanelShortcuts — Keyboard shortcuts for panel collapse/expand.
 *
 * Shortcuts:
 *   Ctrl+[  — toggle left panel
 *   Ctrl+]  — toggle right panel
 *   Ctrl+\  — toggle both (maximize/restore canvas)
 *
 * Ignores shortcuts when an input, textarea, or contentEditable element is focused.
 */

import { useEffect } from 'react';

interface PanelShortcutHandlers {
  toggleLeft: () => void;
  toggleRight: () => void;
  toggleBoth: () => void;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function usePanelShortcuts(handlers: PanelShortcutHandlers): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only trigger with Ctrl (or Cmd on Mac) held
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      // Skip if user is typing in an input field
      if (isEditableTarget(e.target)) return;

      switch (e.key) {
        case '[':
          e.preventDefault();
          handlers.toggleLeft();
          break;
        case ']':
          e.preventDefault();
          handlers.toggleRight();
          break;
        case '\\':
          e.preventDefault();
          handlers.toggleBoth();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handlers]);
}
