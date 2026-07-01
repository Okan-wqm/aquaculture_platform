/**
 * SceneTreePanel
 * Collapsible tree-view sidebar for hierarchical scene (screen) navigation.
 * Supports drag-to-reparent, right-click context menu, inline rename.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  LayoutDashboard,
  Workflow,
  AlertTriangle,
  TrendingUp,
  Settings2,
  Gauge,
  ChevronRight,
  ChevronDown,
  Plus,
  GripVertical,
  FolderTree,
  Download,
  Upload,
} from 'lucide-react';
import { useScadaPackageStore } from '../../store/scada';
import { buildScreenTree, wouldCreateCycle, type ScreenTreeNode } from '../../store/scada/sceneUtils';
import type { ScreenType } from '../../store/scada/types';

/* ------------------------------------------------------------------ */
/*  Icon Mapping                                                       */
/* ------------------------------------------------------------------ */

const ICON_MAP: Record<string, React.FC<{ className?: string }>> = {
  LayoutDashboard,
  Workflow,
  AlertTriangle,
  TrendingUp,
  Settings2,
  Gauge,
};

function getScreenIcon(iconName: string): React.ReactNode {
  const IconComponent = ICON_MAP[iconName] || LayoutDashboard;
  return <IconComponent className="w-3.5 h-3.5 flex-shrink-0" />;
}

/* ------------------------------------------------------------------ */
/*  Context Menu Types                                                 */
/* ------------------------------------------------------------------ */

interface ContextMenuState {
  x: number;
  y: number;
  screenId: string;
}

/* ------------------------------------------------------------------ */
/*  TreeNodeRow                                                        */
/* ------------------------------------------------------------------ */

interface TreeNodeRowProps {
  node: ScreenTreeNode;
  activeScreenId: string;
  expandedIds: Set<string>;
  renamingId: string | null;
  renameValue: string;
  dragOverId: string | null;
  onToggleExpand: (id: string) => void;
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, screenId: string) => void;
  onRenameChange: (value: string) => void;
  onRenameSubmit: (id: string) => void;
  onRenameCancel: () => void;
  onDragStart: (e: React.DragEvent, screenId: string) => void;
  onDragOver: (e: React.DragEvent, screenId: string) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent, targetId: string) => void;
}

const TreeNodeRow: React.FC<TreeNodeRowProps> = ({
  node,
  activeScreenId,
  expandedIds,
  renamingId,
  renameValue,
  dragOverId,
  onToggleExpand,
  onSelect,
  onContextMenu,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
}) => {
  const { screen, children, depth } = node;
  const isActive = screen.id === activeScreenId;
  const isExpanded = expandedIds.has(screen.id);
  const hasChildren = children.length > 0;
  const isDragOver = dragOverId === screen.id;
  const isRenaming = renamingId === screen.id;

  return (
    <>
      <div
        draggable={!isRenaming}
        onDragStart={(e) => onDragStart(e, screen.id)}
        onDragOver={(e) => onDragOver(e, screen.id)}
        onDragLeave={onDragLeave}
        onDrop={(e) => onDrop(e, screen.id)}
        onClick={() => onSelect(screen.id)}
        onContextMenu={(e) => onContextMenu(e, screen.id)}
        className={`
          flex items-center gap-1 py-1.5 px-2 text-xs cursor-pointer select-none
          transition-colors group
          ${isActive ? 'bg-cyan-50 text-cyan-600' : 'text-gray-700 hover:bg-gray-50'}
          ${isDragOver ? 'ring-1 ring-inset ring-cyan-400 bg-cyan-50/50' : ''}
        `}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        {/* Drag grip */}
        <GripVertical className="w-3 h-3 text-gray-500 opacity-0 group-hover:opacity-100 flex-shrink-0 cursor-grab" />

        {/* Expand/collapse chevron */}
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand(screen.id);
            }}
            className="flex-shrink-0 p-0 border-none bg-transparent cursor-pointer"
          >
            {isExpanded ? (
              <ChevronDown className="w-3 h-3 text-gray-500" />
            ) : (
              <ChevronRight className="w-3 h-3 text-gray-500" />
            )}
          </button>
        ) : (
          <span className="w-3 flex-shrink-0" />
        )}

        {/* Screen icon */}
        {getScreenIcon(screen.icon)}

        {/* Name or rename input */}
        {isRenaming ? (
          <input
            type="text"
            value={renameValue}
            onChange={(e) => onRenameChange(e.target.value)}
            onBlur={() => onRenameSubmit(screen.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRenameSubmit(screen.id);
              if (e.key === 'Escape') onRenameCancel();
            }}
            onClick={(e) => e.stopPropagation()}
            autoFocus
            className="flex-1 min-w-0 px-1 py-0 text-xs border border-cyan-400 rounded bg-white focus:outline-hidden focus:ring-1 focus:ring-cyan-500"
          />
        ) : (
          <span className="truncate flex-1 min-w-0">{screen.name}</span>
        )}
      </div>

      {/* Render children if expanded */}
      {hasChildren && isExpanded &&
        children.map((child) => (
          <TreeNodeRow
            key={child.screen.id}
            node={child}
            activeScreenId={activeScreenId}
            expandedIds={expandedIds}
            renamingId={renamingId}
            renameValue={renameValue}
            dragOverId={dragOverId}
            onToggleExpand={onToggleExpand}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            onRenameChange={onRenameChange}
            onRenameSubmit={onRenameSubmit}
            onRenameCancel={onRenameCancel}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          />
        ))
      }
    </>
  );
};

/* ------------------------------------------------------------------ */
/*  SceneTreePanel                                                     */
/* ------------------------------------------------------------------ */

export const SceneTreePanel: React.FC = () => {
  const screens = useScadaPackageStore((s) => s.screens);
  const activeScreenId = useScadaPackageStore((s) => s.activeScreenId);
  const setActiveScreen = useScadaPackageStore((s) => s.setActiveScreen);
  const addScreen = useScadaPackageStore((s) => s.addScreen);
  const removeScreen = useScadaPackageStore((s) => s.removeScreen);
  const updateScreen = useScadaPackageStore((s) => s.updateScreen);
  const duplicateScreen = useScadaPackageStore((s) => s.duplicateScreen);

  /* ---- Local state ---- */
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    // Default: all screens expanded
    return new Set(screens.map((s) => s.id));
  });
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const contextMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Keep expandedIds in sync when new screens are added
  useEffect(() => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      for (const s of screens) {
        // Expand newly added screens by default
        if (!next.has(s.id)) next.add(s.id);
      }
      return next;
    });
  }, [screens]);

  /* ---- Tree data ---- */
  const tree = buildScreenTree(screens);

  /* ---- Expand / Collapse ---- */
  const handleToggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  /* ---- Selection ---- */
  const handleSelect = useCallback(
    (id: string) => {
      setActiveScreen(id);
    },
    [setActiveScreen],
  );

  /* ---- Context Menu ---- */
  const handleContextMenu = useCallback((e: React.MouseEvent, screenId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const menuWidth = 176;
    const menuHeight = 180;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight);
    setContextMenu({ x, y, screenId });
  }, []);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextMenu]);

  const handleAddChildScreen = useCallback(
    (parentId: string) => {
      addScreen('dashboard' as ScreenType, 'New Screen');
      // The newly added screen is the last one in the store
      const latestScreens = useScadaPackageStore.getState().screens;
      const newScreen = latestScreens[latestScreens.length - 1];
      if (newScreen) {
        updateScreen(newScreen.id, { parentId });
      }
      setContextMenu(null);
    },
    [addScreen, updateScreen],
  );

  const handleRenameStart = useCallback(
    (screenId: string) => {
      const screen = screens.find((s) => s.id === screenId);
      if (screen) {
        setRenamingId(screen.id);
        setRenameValue(screen.name);
      }
      setContextMenu(null);
    },
    [screens],
  );

  const handleRenameSubmit = useCallback(
    (id: string) => {
      if (renameValue.trim()) {
        updateScreen(id, { name: renameValue.trim() });
      }
      setRenamingId(null);
    },
    [renameValue, updateScreen],
  );

  const handleRenameCancel = useCallback(() => {
    setRenamingId(null);
  }, []);

  const handleDuplicate = useCallback(
    (screenId: string) => {
      duplicateScreen(screenId);
      setContextMenu(null);
    },
    [duplicateScreen],
  );

  const handleDelete = useCallback(
    (screenId: string) => {
      if (screens.length <= 1) return;
      removeScreen(screenId);
      setContextMenu(null);
    },
    [screens.length, removeScreen],
  );

  const handleAddRootScreen = useCallback(() => {
    addScreen('dashboard' as ScreenType, 'New Screen');
  }, [addScreen]);

  /* ---- Drag & Drop ---- */
  const handleDragStart = useCallback((e: React.DragEvent, screenId: string) => {
    e.dataTransfer.setData('text/plain', screenId);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverId(targetId);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverId(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, targetId: string) => {
      e.preventDefault();
      setDragOverId(null);

      const draggedId = e.dataTransfer.getData('text/plain');
      if (!draggedId || draggedId === targetId) return;

      // Prevent creating cycles
      if (wouldCreateCycle(screens, draggedId, targetId)) return;

      updateScreen(draggedId, { parentId: targetId });
    },
    [screens, updateScreen],
  );

  const handleDropOnRoot = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOverId(null);

      const draggedId = e.dataTransfer.getData('text/plain');
      if (!draggedId) return;

      updateScreen(draggedId, { parentId: null });
    },
    [updateScreen],
  );

  const handleDragOverRoot = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverId('__root__');
  }, []);

  /* ---- Export / Import ---- */
  const handleExportScreen = useCallback(
    (screenId: string) => {
      const screen = screens.find((s) => s.id === screenId);
      if (!screen) return;
      import('../../store/scada/screenIO').then(({ downloadScreenJSON }) => {
        downloadScreenJSON(screen);
      });
      setContextMenu(null);
    },
    [screens],
  );

  const handleImportScreen = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        const { importScreen } = await import('../../store/scada/screenIO');
        const newScreen = importScreen(json);
        // Use immer-powered set to push the imported screen into the store
        useScadaPackageStore.setState((state) => {
          state.screens.push(newScreen);
          state.activeScreenId = newScreen.id;
          state.isDirty = true;
        });
      } catch (err) {
        console.error('Screen import failed:', err);
      }
      // Reset file input so re-selecting the same file triggers onChange
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [],
  );

  const isLastScreen = screens.length <= 1;

  return (
    <div className="w-full h-full flex flex-col bg-white select-none">
      {/* Header */}
      <div className="flex items-center justify-between px-2 py-2 border-b border-gray-200">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-700">
          <FolderTree className="w-3.5 h-3.5 text-gray-500" />
          <span>Scene Tree</span>
        </div>
        <button
          onClick={handleAddRootScreen}
          className="flex items-center justify-center w-5 h-5 rounded text-gray-500 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          title="Add root screen"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Tree content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden py-1">
        {tree.map((node) => (
          <TreeNodeRow
            key={node.screen.id}
            node={node}
            activeScreenId={activeScreenId}
            expandedIds={expandedIds}
            renamingId={renamingId}
            renameValue={renameValue}
            dragOverId={dragOverId}
            onToggleExpand={handleToggleExpand}
            onSelect={handleSelect}
            onContextMenu={handleContextMenu}
            onRenameChange={setRenameValue}
            onRenameSubmit={handleRenameSubmit}
            onRenameCancel={handleRenameCancel}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          />
        ))}

        {/* Root drop zone */}
        <div
          onDragOver={handleDragOverRoot}
          onDragLeave={handleDragLeave}
          onDrop={handleDropOnRoot}
          className={`
            mx-2 mt-1 py-2 border border-dashed rounded text-center text-[10px] text-gray-500
            transition-colors
            ${dragOverId === '__root__' ? 'border-cyan-400 bg-cyan-50/50 text-cyan-500' : 'border-gray-200'}
          `}
        >
          Move to root
        </div>
      </div>

      {/* Import button at bottom */}
      <div className="border-t border-gray-200 px-2 py-1.5">
        <button
          onClick={handleImportScreen}
          className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs text-gray-600 hover:bg-gray-50 rounded transition-colors"
          title="Import screen from JSON file"
        >
          <Upload className="w-3.5 h-3.5" />
          Import Screen
        </button>
      </div>

      {/* Hidden file input for import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.scada-screen.json"
        className="hidden"
        onChange={handleFileSelected}
      />

      {/* Context Menu */}
      {contextMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setContextMenu(null)}
          />
          <div
            ref={contextMenuRef}
            className="fixed bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50 w-44"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              onClick={() => handleAddChildScreen(contextMenu.screenId)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
            >
              Add Child Screen
            </button>
            <button
              onClick={() => handleRenameStart(contextMenu.screenId)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
            >
              Rename
            </button>
            <button
              onClick={() => handleDuplicate(contextMenu.screenId)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
            >
              Duplicate
            </button>
            <button
              onClick={() => handleExportScreen(contextMenu.screenId)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
            >
              <Download className="w-3 h-3" />
              Export Screen
            </button>
            <hr className="my-1 border-gray-200" />
            <button
              onClick={() => handleDelete(contextMenu.screenId)}
              disabled={isLastScreen}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs ${
                isLastScreen
                  ? 'text-gray-500 cursor-not-allowed'
                  : 'text-red-600 hover:bg-red-50'
              }`}
            >
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default SceneTreePanel;
