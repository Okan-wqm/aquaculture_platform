import { useEffect, useRef, useCallback } from 'react';
import { useScadaPackageStore } from '../store/scada';

interface UseScadaKeyboardShortcutsOptions {
  /** Called when Ctrl+S is pressed. The hook prevents default browser save. */
  onSave?: () => void;
  /** Whether the builder is in preview mode (disables shortcuts). */
  isPreview?: boolean;
}

export function useScadaKeyboardShortcuts(
  options: UseScadaKeyboardShortcutsOptions = {},
): void {
  const { onSave, isPreview = false } = options;

  // Keep onSave in a ref so the keydown handler never goes stale
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const handler = useCallback((e: KeyboardEvent) => {
    // Skip when user is typing in form elements
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((e.target as HTMLElement)?.isContentEditable) return;

    // Support both Ctrl (Windows/Linux) and Cmd (Mac)
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    const s = useScadaPackageStore.getState();

    // Ctrl+S — Save
    if (mod && key === 's') {
      e.preventDefault();
      onSaveRef.current?.();
      return;
    }

    // Ctrl+Z — Undo
    if (mod && !e.shiftKey && key === 'z') {
      e.preventDefault();
      if (s.canUndo()) s.undo();
      return;
    }

    // Ctrl+Y or Ctrl+Shift+Z — Redo
    if (mod && (key === 'y' || (e.shiftKey && key === 'z'))) {
      e.preventDefault();
      if (s.canRedo()) s.redo();
      return;
    }

    // Ctrl+C — Copy
    if (mod && key === 'c') {
      e.preventDefault();
      s.copySelectedWidgets();
      return;
    }

    // Ctrl+X — Cut
    if (mod && key === 'x') {
      e.preventDefault();
      s.cutSelectedWidgets();
      return;
    }

    // Ctrl+V — Paste
    if (mod && key === 'v') {
      e.preventDefault();
      s.pasteWidgets();
      return;
    }

    // Ctrl+D — Duplicate selected widget(s) in place
    if (mod && key === 'd') {
      e.preventDefault();
      // Copy then paste (creates duplicates offset by 1 grid cell)
      if (s.selectedWidgetIds.length > 0) {
        s.copySelectedWidgets();
        s.pasteWidgets();
      }
      return;
    }

    // Delete or Backspace — Remove selected widget(s) or edge
    if (key === 'delete' || key === 'backspace') {
      if (s.selectedWidgetIds.length > 0 && s.activeScreenId) {
        e.preventDefault();
        // Remove all selected widgets
        for (const widgetId of [...s.selectedWidgetIds]) {
          s.removeWidget(s.activeScreenId, widgetId);
        }
      } else if (s.selectedEdgeId && s.activeScreenId) {
        e.preventDefault();
        s.removeEdge(s.activeScreenId, s.selectedEdgeId);
      }
      return;
    }

    // Escape — Deselect everything
    if (key === 'escape') {
      e.preventDefault();
      s.setSelectedWidget(null);
      s.setSelectedEdge(null);
      return;
    }

    // Ctrl+A — Select all widgets
    if (mod && key === 'a') {
      e.preventDefault();
      s.selectAllWidgets();
      return;
    }

    // Ctrl+G — Group selected widgets
    if (mod && key === 'g' && !e.shiftKey) {
      e.preventDefault();
      if (s.selectedWidgetIds.length >= 2 && s.activeScreenId) {
        if ('groupWidgets' in s) {
          (s as any).groupWidgets(s.activeScreenId, s.selectedWidgetIds);
        }
      }
      return;
    }

    // Ctrl+Shift+G — Ungroup
    if (mod && e.shiftKey && key === 'g') {
      e.preventDefault();
      if (s.selectedWidgetId && s.activeScreenId) {
        const screen = s.screens.find((scr) => scr.id === s.activeScreenId);
        const widget = screen?.widgets.find((w) => w.id === s.selectedWidgetId);
        if (widget?.groupId && 'ungroupWidgets' in s) {
          (s as any).ungroupWidgets(s.activeScreenId, widget.groupId);
        }
      }
      return;
    }

    // Ctrl+L — Toggle lock on selected widget
    if (mod && key === 'l') {
      e.preventDefault();
      if (s.selectedWidgetId && s.activeScreenId) {
        if ('toggleWidgetLock' in s) {
          (s as any).toggleWidgetLock(s.activeScreenId, s.selectedWidgetId);
        }
      }
      return;
    }
  }, []);

  useEffect(() => {
    if (isPreview) return;

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isPreview, handler]);
}
