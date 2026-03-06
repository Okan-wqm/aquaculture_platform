/**
 * ScreenTabBar
 * Tab bar for managing screens within a SCADA package.
 * Shows tabs per screen, add screen dropdown, right-click context menu.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
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
import { useScadaPackageStore, ScreenType, ScreenDef } from '../../store/scadaPackageStore';

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

  const addBtnRef = useRef<HTMLButtonElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (showAddDropdown && addBtnRef.current && !addBtnRef.current.parentElement?.contains(e.target as Node)) {
        setShowAddDropdown(false);
      }
      if (contextMenu && contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showAddDropdown, contextMenu]);

  const handleAddScreen = useCallback((type: ScreenType) => {
    const label = SCREEN_TYPE_OPTIONS.find((o) => o.type === type)?.label || type;
    addScreen(type, label);
    setShowAddDropdown(false);
  }, [addScreen]);

  const handleContextMenu = useCallback((e: React.MouseEvent, screenId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, screenId });
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

  const handleDelete = useCallback((screenId: string) => {
    removeScreen(screenId);
    setContextMenu(null);
  }, [removeScreen]);

  const handleSetDefault = useCallback((screenId: string) => {
    setDefaultScreen(screenId);
    setContextMenu(null);
  }, [setDefaultScreen]);

  const isLastScreen = screens.length <= 1;

  return (
    <div className="flex items-center gap-1 px-2 py-1.5 bg-gray-100 border-b border-gray-200 overflow-x-auto">
      {screens.map((screen) => {
        const isActive = screen.id === activeScreenId;

        if (renamingId === screen.id) {
          return (
            <input
              key={screen.id}
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={() => handleRenameSubmit(screen.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameSubmit(screen.id);
                if (e.key === 'Escape') setRenamingId(null);
              }}
              autoFocus
              className="px-2 py-1 text-xs border border-cyan-400 rounded bg-white focus:outline-none focus:ring-1 focus:ring-cyan-500 w-28"
            />
          );
        }

        return (
          <button
            key={screen.id}
            onClick={() => setActiveScreen(screen.id)}
            onContextMenu={(e) => handleContextMenu(e, screen.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              isActive
                ? 'bg-white text-gray-900 shadow-sm border border-gray-200'
                : 'text-gray-600 hover:bg-gray-200 hover:text-gray-800'
            }`}
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
      <div className="relative flex items-center gap-0.5">
        <button
          ref={addBtnRef}
          onClick={() => setShowAddDropdown(!showAddDropdown)}
          className="flex items-center justify-center w-7 h-7 rounded-md text-gray-500 hover:bg-gray-200 hover:text-gray-700 transition-colors"
          title="Ekran Ekle"
        >
          <Plus className="w-4 h-4" />
        </button>
        <button
          onClick={() => activeScreenId && handleDelete(activeScreenId)}
          disabled={isLastScreen}
          className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
            isLastScreen
              ? 'text-gray-300 cursor-not-allowed'
              : 'text-gray-500 hover:bg-red-100 hover:text-red-600'
          }`}
          title="Ekrani Sil"
        >
          <Minus className="w-4 h-4" />
        </button>

        {showAddDropdown && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setShowAddDropdown(false)}
            />
            <div className="absolute left-0 top-full mt-1 w-44 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
              {SCREEN_TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.type}
                  onClick={() => handleAddScreen(opt.type)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  {opt.icon}
                  {opt.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

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
              onClick={() => {
                const screen = screens.find((s) => s.id === contextMenu.screenId);
                if (screen) handleRenameStart(screen);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              Yeniden Adlandir
            </button>
            <button
              onClick={() => handleDuplicate(contextMenu.screenId)}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              Cokla
            </button>
            <button
              onClick={() => handleSetDefault(contextMenu.screenId)}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              Varsayilan Yap
            </button>
            <hr className="my-1 border-gray-200" />
            <button
              onClick={() => handleDelete(contextMenu.screenId)}
              disabled={isLastScreen}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm ${
                isLastScreen
                  ? 'text-gray-300 cursor-not-allowed'
                  : 'text-red-600 hover:bg-red-50'
              }`}
            >
              Sil
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default ScreenTabBar;
