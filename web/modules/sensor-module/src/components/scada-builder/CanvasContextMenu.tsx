import React, { useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Scissors,
  Copy,
  ClipboardPaste,
  Trash2,
  ArrowUpToLine,
  ArrowDownToLine,
  MousePointer,
  Group,
  Ungroup,
  Lock,
  Unlock,
} from 'lucide-react';
import { useScadaStore } from '../../store/scada';

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
        ? 'cursor-not-allowed text-gray-300'
        : 'text-gray-700 hover:bg-gray-50'
    }`}
    disabled={disabled}
    onClick={onClick}
  >
    {icon}
    <span>{label}</span>
    {shortcut && <span className="ml-auto text-xs text-gray-400">{shortcut}</span>}
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

  const activeScreenId = useScadaStore((s) => s.activeScreenId);
  const selectedWidgetId = useScadaStore((s) => s.selectedWidgetId);
  const selectedEdgeId = useScadaStore((s) => s.selectedEdgeId);
  const selectedWidgetIds = useScadaStore((s) => s.selectedWidgetIds);
  const clipboard = useScadaStore((s) => s.clipboard);

  const hasClipboard = clipboard !== null;

  // Compute current widget's group ID and lock state
  const currentGroupId = useMemo(() => {
    if (!activeScreenId || !selectedWidgetId) return null;
    const screen = useScadaStore.getState().screens.find((s) => s.id === activeScreenId);
    const widget = screen?.widgets.find((w) => w.id === selectedWidgetId);
    return widget?.groupId ?? null;
  }, [activeScreenId, selectedWidgetId]);

  const isLocked = useMemo(() => {
    if (!activeScreenId || !selectedWidgetId) return false;
    const screen = useScadaStore.getState().screens.find((s) => s.id === activeScreenId);
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
    useScadaStore.getState().cutSelectedWidgets();
    onClose();
  };

  const handleCopy = () => {
    useScadaStore.getState().copySelectedWidgets();
    onClose();
  };

  const handlePaste = () => {
    useScadaStore.getState().pasteWidgets();
    onClose();
  };

  const handleDeleteWidget = () => {
    if (activeScreenId && selectedWidgetId) {
      useScadaStore.getState().removeWidget(activeScreenId, selectedWidgetId);
    }
    onClose();
  };

  const handleDeleteEdge = () => {
    if (activeScreenId && selectedEdgeId) {
      useScadaStore.getState().removeEdge(activeScreenId, selectedEdgeId);
    }
    onClose();
  };

  const handleBringToFront = () => {
    const store = useScadaStore.getState();
    if ('bringToFront' in store) {
      (store as any).bringToFront(store.activeScreenId, store.selectedWidgetId);
    }
    onClose();
  };

  const handleSendToBack = () => {
    const store = useScadaStore.getState();
    if ('sendToBack' in store) {
      (store as any).sendToBack(store.activeScreenId, store.selectedWidgetId);
    }
    onClose();
  };

  const handleGroup = () => {
    const store = useScadaStore.getState();
    if ('groupWidgets' in store && store.activeScreenId) {
      (store as any).groupWidgets(store.activeScreenId, store.selectedWidgetIds);
    }
    onClose();
  };

  const handleUngroup = () => {
    const store = useScadaStore.getState();
    if ('ungroupWidgets' in store && store.activeScreenId && currentGroupId) {
      (store as any).ungroupWidgets(store.activeScreenId, currentGroupId);
    }
    onClose();
  };

  const handleToggleLock = () => {
    const store = useScadaStore.getState();
    if ('toggleWidgetLock' in store && store.activeScreenId && store.selectedWidgetId) {
      (store as any).toggleWidgetLock(store.activeScreenId, store.selectedWidgetId);
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
            label="Kes"
            shortcut="Ctrl+X"
            onClick={handleCut}
          />
          <MenuItem
            icon={<Copy className="h-4 w-4" />}
            label="Kopyala"
            shortcut="Ctrl+C"
            onClick={handleCopy}
          />
          <MenuItem
            icon={<ClipboardPaste className="h-4 w-4" />}
            label="Yapıştır"
            shortcut="Ctrl+V"
            disabled={!hasClipboard}
            onClick={handlePaste}
          />
          <Separator />
          <MenuItem
            icon={<ArrowUpToLine className="h-4 w-4" />}
            label="Öne Getir"
            onClick={handleBringToFront}
          />
          <MenuItem
            icon={<ArrowDownToLine className="h-4 w-4" />}
            label="Arkaya Gönder"
            onClick={handleSendToBack}
          />
          {/* Group/Ungroup */}
          <Separator />
          {selectedWidgetIds.length >= 2 && (
            <MenuItem
              icon={<Group className="h-4 w-4" />}
              label="Grupla"
              shortcut="Ctrl+G"
              onClick={handleGroup}
            />
          )}
          {currentGroupId && (
            <MenuItem
              icon={<Ungroup className="h-4 w-4" />}
              label="Grubu Çöz"
              shortcut="Ctrl+Shift+G"
              onClick={handleUngroup}
            />
          )}
          {/* Lock/Unlock */}
          <MenuItem
            icon={isLocked ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
            label={isLocked ? "Kilidi Aç" : "Kilitle"}
            shortcut="Ctrl+L"
            onClick={handleToggleLock}
          />
          <Separator />
          <MenuItem
            icon={<Trash2 className="h-4 w-4" />}
            label="Sil"
            shortcut="Del"
            onClick={handleDeleteWidget}
          />
        </>
      )}

      {target === 'edge' && (
        <MenuItem
          icon={<Trash2 className="h-4 w-4" />}
          label="Sil"
          onClick={handleDeleteEdge}
        />
      )}

      {target === 'canvas' && (
        <>
          <MenuItem
            icon={<ClipboardPaste className="h-4 w-4" />}
            label="Yapıştır"
            shortcut="Ctrl+V"
            disabled={!hasClipboard}
            onClick={handlePaste}
          />
          <MenuItem
            icon={<MousePointer className="h-4 w-4" />}
            label="Tümünü Seç"
            disabled
            onClick={() => onClose()}
          />
        </>
      )}
    </div>
  );
};
