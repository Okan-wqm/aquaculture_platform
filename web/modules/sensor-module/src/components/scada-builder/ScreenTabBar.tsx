/**
 * ScreenTabBar
 * Tab bar for managing screens within a SCADA package.
 * Shows tabs per screen, add screen dropdown, right-click context menu.
 */

import React, { useState, useRef, useCallback } from 'react';
import { useConfirm, useClickOutside, colors as themeColors, Button, Input } from '@aquaculture/shared-ui';
import {
  Plus,
  Minus,
  Star,
  LayoutDashboard,
  Workflow,
  AlertTriangle,
  TrendingUp,
  Settings2,
  Gauge,
} from 'lucide-react';
import { useScadaPackageStore, ScreenType, ScreenDef } from '../../store/scada';

const SCREEN_TYPE_OPTIONS: { type: ScreenType; label: string; icon: React.ReactNode }[] = [
  { type: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-4 h-4" /> },
  { type: 'process', label: 'Process', icon: <Workflow className="w-4 h-4" /> },
  { type: 'alarms', label: 'Alarms', icon: <AlertTriangle className="w-4 h-4" /> },
  { type: 'trends', label: 'Trends', icon: <TrendingUp className="w-4 h-4" /> },
  { type: 'calibration', label: 'Calibration', icon: <Settings2 className="w-4 h-4" /> },
  { type: 'control', label: 'Control', icon: <Gauge className="w-4 h-4" /> },
];

const ICON_MAP: Record<string, React.ReactNode> = {
  LayoutDashboard: <LayoutDashboard className="w-3.5 h-3.5" />,
  Workflow: <Workflow className="w-3.5 h-3.5" />,
  AlertTriangle: <AlertTriangle className="w-3.5 h-3.5" />,
  TrendingUp: <TrendingUp className="w-3.5 h-3.5" />,
  Settings2: <Settings2 className="w-3.5 h-3.5" />,
  Gauge: <Gauge className="w-3.5 h-3.5" />,
};

function getScreenIcon(iconName: string): React.ReactNode {
  return ICON_MAP[iconName] || <LayoutDashboard className="w-3.5 h-3.5" />;
}

const ScreenTabBar: React.FC = () => {
  const confirm = useConfirm();
  const screens = useScadaPackageStore((s) => s.screens);
  const activeScreenId = useScadaPackageStore((s) => s.activeScreenId);
  const setActiveScreen = useScadaPackageStore((s) => s.setActiveScreen);
  const addScreen = useScadaPackageStore((s) => s.addScreen);
  const removeScreen = useScadaPackageStore((s) => s.removeScreen);
  const duplicateScreen = useScadaPackageStore((s) => s.duplicateScreen);
  const updateScreen = useScadaPackageStore((s) => s.updateScreen);
  const setDefaultScreen = useScadaPackageStore((s) => s.setDefaultScreen);

  const [showAddDropdown, setShowAddDropdown] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; screenId: string } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const addBtnRef = useRef<HTMLButtonElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ x: number; y: number } | null>(null);

  // Close the add-screen menu and the context menu on outside click. The
  // add menu is fixed-positioned but rendered inside its button group, so
  // DOM containment (not geometry) decides what counts as "inside".
  useClickOutside(addMenuRef, () => setShowAddDropdown(false), showAddDropdown);
  useClickOutside(contextMenuRef, () => setContextMenu(null), contextMenu !== null);

  const handleAddScreen = useCallback((type: ScreenType) => {
    const label = SCREEN_TYPE_OPTIONS.find((o) => o.type === type)?.label || type;
    addScreen(type, label);
    setShowAddDropdown(false);
  }, [addScreen]);

  const handleContextMenu = useCallback((e: React.MouseEvent, screenId: string) => {
    e.preventDefault();
    const menuWidth = 176; // w-44 = 11rem = 176px
    const menuHeight = 200; // approximate
    const x = Math.min(e.clientX, window.innerWidth - menuWidth);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight);
    setContextMenu({ x, y, screenId });
  }, []);

  const handleRenameStart = useCallback((screen: ScreenDef) => {
    setRenamingId(screen.id);
    setRenameValue(screen.name);
    setContextMenu(null);
  }, []);

  const handleRenameSubmit = useCallback((id: string) => {
    if (renameValue.trim()) {
      updateScreen(id, { name: renameValue.trim() });
    }
    setRenamingId(null);
  }, [renameValue, updateScreen]);

  const handleDuplicate = useCallback((screenId: string) => {
    duplicateScreen(screenId);
    setContextMenu(null);
  }, [duplicateScreen]);

  const handleDelete = useCallback(async (screenId: string): Promise<void> => {
    if (!(await confirm({ title: 'Delete this screen?', message: 'Widgets placed on it are removed with it.', confirmText: 'Delete', cancelText: 'Cancel', variant: 'danger' }))) return;
    removeScreen(screenId);
    setContextMenu(null);
  }, [removeScreen, confirm]);

  const handleSetDefault = useCallback((screenId: string) => {
    setDefaultScreen(screenId);
    setContextMenu(null);
  }, [setDefaultScreen]);

  const handleReorder = useCallback((dragId: string, dropId: string) => {
    const state = useScadaPackageStore.getState();
    const screensCopy = [...state.screens];
    const dragIdx = screensCopy.findIndex((s) => s.id === dragId);
    const dropIdx = screensCopy.findIndex((s) => s.id === dropId);
    if (dragIdx === -1 || dropIdx === -1) return;

    // Remove dragged screen and insert before drop target
    const [dragged] = screensCopy.splice(dragIdx, 1);
    const insertIdx = screensCopy.findIndex((s) => s.id === dropId);
    screensCopy.splice(insertIdx, 0, dragged);

    // Update sortOrder for all screens
    screensCopy.forEach((screen, idx) => {
      updateScreen(screen.id, { sortOrder: idx });
    });
  }, [updateScreen]);

  const isLastScreen = screens.length <= 1;

  return (
    <div className="flex items-center gap-1 px-2 py-1.5 bg-gray-100 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 overflow-x-auto">
      {screens.map((screen) => {
        const isActive = screen.id === activeScreenId;

        if (renamingId === screen.id) {
          return (
            <Input key={screen.id} type="text" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} onBlur={() => handleRenameSubmit(screen.id)} onKeyDown={(e) => {
        if (e.key === 'Enter') handleRenameSubmit(screen.id);
        if (e.key === 'Escape') setRenamingId(null);
       }} autoFocus />
          );
        }

        return (
          <button
            key={screen.id}
            onClick={() => setActiveScreen(screen.id)}
            onContextMenu={(e) => handleContextMenu(e, screen.id)}
            draggable
            onDragStart={(e) => {
              setDraggedTabId(screen.id);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', screen.id);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (draggedTabId && draggedTabId !== screen.id) {
                setDropTargetId(screen.id);
              }
            }}
            onDragLeave={() => {
              if (dropTargetId === screen.id) setDropTargetId(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (draggedTabId && draggedTabId !== screen.id) {
                handleReorder(draggedTabId, screen.id);
              }
              setDraggedTabId(null);
              setDropTargetId(null);
            }}
            onDragEnd={() => {
              setDraggedTabId(null);
              setDropTargetId(null);
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              isActive
                ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 shadow-sm border border-gray-200 dark:border-gray-700'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600 hover:text-gray-800 dark:hover:text-gray-100'
            }`}
            style={{
              opacity: draggedTabId === screen.id ? 0.5 : 1,
              borderLeft: dropTargetId === screen.id ? `2px solid ${themeColors.primary[400]}` : undefined,
              cursor: draggedTabId ? 'grabbing' : 'default',
            }}
          >
            {getScreenIcon(screen.icon)}
            <span>{screen.name}</span>
            {screen.isDefault && (
              <Star className="w-3 h-3 text-yellow-500 fill-yellow-400" />
            )}
          </button>
        );
      })}

      {/* Add / Remove Screen Buttons */}
      <div className="relative flex items-center gap-0.5" ref={addMenuRef}>
        <Button variant="ghost" iconOnly className="justify-center w-7 h-7" ref={addBtnRef} onClick={() => {
            if (!showAddDropdown && addBtnRef.current) {
              const rect = addBtnRef.current.getBoundingClientRect();
              setDropdownPos({ x: rect.left, y: rect.bottom + 4 });
            }
            setShowAddDropdown(!showAddDropdown);
          }} aria-label="Add Screen" title="Add Screen"><Plus className="w-4 h-4" /></Button>
        <button
          onClick={() => { if (activeScreenId) void handleDelete(activeScreenId); }}
          disabled={isLastScreen}
          className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
            isLastScreen
              ? 'text-gray-500 dark:text-gray-400 cursor-not-allowed'
              : 'text-gray-500 dark:text-gray-400 hover:bg-red-100 hover:text-red-600'
          }`}
          aria-label="Delete Screen"
          title="Delete Screen"
        >
          <Minus className="w-4 h-4" />
        </button>

        {showAddDropdown && (
          <div
            className="fixed w-44 bg-white dark:bg-gray-900 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-50"
            style={{ left: dropdownPos?.x ?? 0, top: dropdownPos?.y ?? 0 }}
          >
            {SCREEN_TYPE_OPTIONS.map((opt) => (
              <Button variant="ghost" size="sm" key={opt.type} onClick={() => handleAddScreen(opt.type)}>{opt.icon}
                {opt.label}</Button>
            ))}
          </div>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed bg-white dark:bg-gray-900 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-50 w-44"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <Button variant="ghost" size="sm" onClick={() => {
              const screen = screens.find((s) => s.id === contextMenu.screenId);
              if (screen) handleRenameStart(screen);
            }}>Rename</Button>
          <Button variant="ghost" size="sm" onClick={() => handleDuplicate(contextMenu.screenId)}>Duplicate</Button>
          <Button variant="ghost" size="sm" onClick={() => handleSetDefault(contextMenu.screenId)}>Set as Default</Button>
          <hr className="my-1 border-gray-200 dark:border-gray-700" />
          <button
            onClick={() => void handleDelete(contextMenu.screenId)}
            disabled={isLastScreen}
            className={`w-full flex items-center gap-2 px-3 py-2 text-sm ${
              isLastScreen
                ? 'text-gray-500 dark:text-gray-400 cursor-not-allowed'
                : 'text-red-600 hover:bg-red-50'
            }`}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
};

export default ScreenTabBar;
