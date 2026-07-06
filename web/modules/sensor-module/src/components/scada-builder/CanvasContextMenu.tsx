import React, { useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Scissors,
  Copy,
  ClipboardPaste,
  Trash2,
  ArrowUpToLine,
  ArrowDownToLine,
  ArrowUp,
  ArrowDown,
  MousePointer,
  Group,
  Ungroup,
  Lock,
  Unlock,
  Bookmark,
} from 'lucide-react';
import { useScadaPackageStore } from '../../store/scada';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CanvasContextMenuProps {
  /** Screen coordinates where the menu should appear */
  position: { x: number; y: number };
  /** What was right-clicked */
  target: 'widget' | 'edge' | 'canvas';
  /** Close the menu */
  onClose: () => void;
}

/* ------------------------------------------------------------------ */
/*  Menu Item                                                          */
/* ------------------------------------------------------------------ */

interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}

const MenuItem: React.FC<MenuItemProps> = ({ icon, label, shortcut, disabled, onClick }) => (
  <button
    className={`flex w-full items-center gap-2 px-3 py-2 text-sm ${
      disabled
        ? 'cursor-not-allowed text-gray-500'
        : 'text-gray-700 hover:bg-gray-50'
    }`}
    disabled={disabled}
    onClick={onClick}
  >
    {icon}
    <span>{label}</span>
    {shortcut && <span className="ml-auto text-xs text-gray-500">{shortcut}</span>}
  </button>
);

const Separator: React.FC = () => <div className="my-1 border-t border-gray-100" />;

/* ------------------------------------------------------------------ */
/*  CanvasContextMenu                                                  */
/* ------------------------------------------------------------------ */

export const CanvasContextMenu: React.FC<CanvasContextMenuProps> = ({
  position,
  target,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  const activeScreenId = useScadaPackageStore((s) => s.activeScreenId);
  const selectedWidgetId = useScadaPackageStore((s) => s.selectedWidgetId);
  const selectedEdgeId = useScadaPackageStore((s) => s.selectedEdgeId);
  const selectedWidgetIds = useScadaPackageStore((s) => s.selectedWidgetIds);
  const clipboard = useScadaPackageStore((s) => s.clipboard);

  const hasClipboard = clipboard !== null;

  // Compute current widget's group ID and lock state
  const currentGroupId = useMemo(() => {
    if (!activeScreenId || !selectedWidgetId) return null;
    const screen = useScadaPackageStore.getState().screens.find((s) => s.id === activeScreenId);
    const widget = screen?.widgets.find((w) => w.id === selectedWidgetId);
    return widget?.groupId ?? null;
  }, [activeScreenId, selectedWidgetId]);

  const isLocked = useMemo(() => {
    if (!activeScreenId || !selectedWidgetId) return false;
    const screen = useScadaPackageStore.getState().screens.find((s) => s.id === activeScreenId);
    const widget = screen?.widgets.find((w) => w.id === selectedWidgetId);
    return widget?.locked ?? false;
  }, [activeScreenId, selectedWidgetId]);

  /* ---- Position clamping ---- */

  const clampedPosition = useCallback(() => {
    const menuWidth = 220;
    const menuHeight = 300; // conservative estimate
    const x = Math.min(position.x, window.innerWidth - menuWidth);
    const y = Math.min(position.y, window.innerHeight - menuHeight);
    return { x: Math.max(0, x), y: Math.max(0, y) };
  }, [position]);

  const { x, y } = clampedPosition();

  /* ---- Close on click-outside ---- */

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onClose]);

  /* ---- Close on Escape ---- */

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  /* ---- Action helpers ---- */

  const handleCut = () => {
    useScadaPackageStore.getState().cutSelectedWidgets();
    onClose();
  };

  const handleCopy = () => {
    useScadaPackageStore.getState().copySelectedWidgets();
    onClose();
  };

  const handlePaste = () => {
    useScadaPackageStore.getState().pasteWidgets();
    onClose();
  };

  const handleDeleteWidget = () => {
    if (activeScreenId && selectedWidgetIds.length > 0) {
      const store = useScadaPackageStore.getState();
      for (const wId of [...selectedWidgetIds]) {
        store.removeWidget(activeScreenId, wId);
      }
    } else if (activeScreenId && selectedWidgetId) {
      useScadaPackageStore.getState().removeWidget(activeScreenId, selectedWidgetId);
    }
    onClose();
  };

  const handleDeleteEdge = () => {
    if (activeScreenId && selectedEdgeId) {
      useScadaPackageStore.getState().removeEdge(activeScreenId, selectedEdgeId);
    }
    onClose();
  };

  /**
   * Tip güvenliği düzeltmesi: `as any` cast'leri kaldırıldı.
   * ScadaStore tipi bu action'ları zaten içerir (WidgetSlice, GroupSlice,
   * TemplateSlice). Runtime "in" kontrolü gereksiz — tip sistemi garantiyi sağlar.
   *
   * Type safety fix: removed `as any` casts.
   * ScadaStore type already includes these actions (WidgetSlice, GroupSlice,
   * TemplateSlice). Runtime "in" checks are unnecessary — the type system
   * provides the guarantee.
   */

  const handleBringToFront = () => {
    const store = useScadaPackageStore.getState();
    if (store.activeScreenId && store.selectedWidgetId) {
      store.bringToFront(store.activeScreenId, store.selectedWidgetId);
    }
    onClose();
  };

  const handleSendToBack = () => {
    const store = useScadaPackageStore.getState();
    if (store.activeScreenId && store.selectedWidgetId) {
      store.sendToBack(store.activeScreenId, store.selectedWidgetId);
    }
    onClose();
  };

  const handleBringForward = () => {
    const store = useScadaPackageStore.getState();
    if (store.activeScreenId && store.selectedWidgetId) {
      store.bringForward(store.activeScreenId, store.selectedWidgetId);
    }
    onClose();
  };

  const handleSendBackward = () => {
    const store = useScadaPackageStore.getState();
    if (store.activeScreenId && store.selectedWidgetId) {
      store.sendBackward(store.activeScreenId, store.selectedWidgetId);
    }
    onClose();
  };

  const handleGroup = () => {
    const store = useScadaPackageStore.getState();
    if (store.activeScreenId && store.selectedWidgetIds.length >= 2) {
      store.groupWidgets(store.activeScreenId, store.selectedWidgetIds);
    }
    onClose();
  };

  const handleUngroup = () => {
    const store = useScadaPackageStore.getState();
    if (store.activeScreenId && currentGroupId) {
      store.ungroupWidgets(store.activeScreenId, currentGroupId);
    }
    onClose();
  };

  const handleSaveAsTemplate = () => {
    const store = useScadaPackageStore.getState();
    if (!store.activeScreenId || !store.selectedWidgetId) { onClose(); return; }
    const screen = store.screens.find((s) => s.id === store.activeScreenId);
    const widget = screen?.widgets.find((w) => w.id === store.selectedWidgetId);
    if (!widget) { onClose(); return; }

    const name = (widget.config?.label as string) || widget.widgetType;
    const category = widget.widgetType;
    store.saveAsTemplate(name, category, widget);
    onClose();
  };

  const handleToggleLock = () => {
    const store = useScadaPackageStore.getState();
    if (store.activeScreenId && store.selectedWidgetId) {
      store.toggleWidgetLock(store.activeScreenId, store.selectedWidgetId);
    }
    onClose();
  };

  /* ---- Render ---- */

  return (
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[200px] rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
      style={{ left: x, top: y }}
    >
      {target === 'widget' && (
        <>
          <MenuItem
            icon={<Scissors className="h-4 w-4" />}
            label="Cut"
            shortcut="Ctrl+X"
            onClick={handleCut}
          />
          <MenuItem
            icon={<Copy className="h-4 w-4" />}
            label="Copy"
            shortcut="Ctrl+C"
            onClick={handleCopy}
          />
          <MenuItem
            icon={<ClipboardPaste className="h-4 w-4" />}
            label="Paste"
            shortcut="Ctrl+V"
            disabled={!hasClipboard}
            onClick={handlePaste}
          />
          <Separator />
          <MenuItem
            icon={<ArrowUpToLine className="h-4 w-4" />}
            label="Bring to Front"
            onClick={handleBringToFront}
          />
          <MenuItem
            icon={<ArrowUp className="h-4 w-4" />}
            label="Bring Forward"
            onClick={handleBringForward}
          />
          <MenuItem
            icon={<ArrowDown className="h-4 w-4" />}
            label="Send Backward"
            onClick={handleSendBackward}
          />
          <MenuItem
            icon={<ArrowDownToLine className="h-4 w-4" />}
            label="Send to Back"
            onClick={handleSendToBack}
          />
          {/* Group/Ungroup */}
          <Separator />
          {selectedWidgetIds.length >= 2 && (
            <MenuItem
              icon={<Group className="h-4 w-4" />}
              label="Group"
              shortcut="Ctrl+G"
              onClick={handleGroup}
            />
          )}
          {currentGroupId && (
            <MenuItem
              icon={<Ungroup className="h-4 w-4" />}
              label="Ungroup"
              shortcut="Ctrl+Shift+G"
              onClick={handleUngroup}
            />
          )}
          {/* Lock/Unlock */}
          <MenuItem
            icon={isLocked ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
            label={isLocked ? "Unlock" : "Lock"}
            shortcut="Ctrl+L"
            onClick={handleToggleLock}
          />
          <MenuItem
            icon={<Bookmark className="h-4 w-4" />}
            label="Save as Template"
            onClick={handleSaveAsTemplate}
          />
          <Separator />
          <MenuItem
            icon={<Trash2 className="h-4 w-4" />}
            label="Delete"
            shortcut="Del"
            onClick={handleDeleteWidget}
          />
        </>
      )}

      {target === 'edge' && (
        <MenuItem
          icon={<Trash2 className="h-4 w-4" />}
          label="Delete"
          onClick={handleDeleteEdge}
        />
      )}

      {target === 'canvas' && (
        <>
          <MenuItem
            icon={<ClipboardPaste className="h-4 w-4" />}
            label="Paste"
            shortcut="Ctrl+V"
            disabled={!hasClipboard}
            onClick={handlePaste}
          />
          <MenuItem
            icon={<MousePointer className="h-4 w-4" />}
            label="Select All"
            shortcut="Ctrl+A"
            onClick={() => {
              useScadaPackageStore.getState().selectAllWidgets();
              onClose();
            }}
          />
        </>
      )}
    </div>
  );
};
