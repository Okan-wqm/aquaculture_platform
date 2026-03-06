/**
 * ModeTabBar - 5-mode tab switcher for the Unified SCADA Editor
 *
 * Modes: P&ID, HMI, PLC, Runtime, Debug
 * Supports Ctrl+1..5 keyboard shortcuts.
 */

import React, { useEffect } from 'react';
import { Workflow, LayoutDashboard, Code2, Play, Bug } from 'lucide-react';
import { EditorMode, useEditorModeStore } from '../../store/editorModeStore';

interface ModeTab {
  mode: EditorMode;
  label: string;
  icon: React.FC<{ className?: string }>;
  shortcutKey: string;
}

const TABS: ModeTab[] = [
  { mode: 'pid', label: 'P&ID', icon: Workflow, shortcutKey: '1' },
  { mode: 'hmi', label: 'HMI', icon: LayoutDashboard, shortcutKey: '2' },
  { mode: 'plc', label: 'PLC', icon: Code2, shortcutKey: '3' },
  { mode: 'runtime', label: 'Runtime', icon: Play, shortcutKey: '4' },
  { mode: 'debug', label: 'Debug', icon: Bug, shortcutKey: '5' },
];

const ModeTabBar: React.FC = () => {
  const mode = useEditorModeStore((s) => s.mode);
  const setMode = useEditorModeStore((s) => s.setMode);

  // Ctrl+1..5 keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      // Don't trigger when user is typing in an input/textarea
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }
      const tab = TABS.find((t) => t.shortcutKey === e.key);
      if (tab) {
        e.preventDefault();
        setMode(tab.mode);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setMode]);

  return (
    <div className="flex items-center gap-0.5 bg-gray-100 rounded-lg p-0.5">
      {TABS.map((tab) => {
        const isActive = mode === tab.mode;
        const Icon = tab.icon;
        return (
          <button
            key={tab.mode}
            onClick={() => setMode(tab.mode)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
              isActive
                ? 'bg-white text-cyan-700 shadow-sm'
                : 'text-gray-500 hover:text-gray-700 hover:bg-gray-200'
            }`}
            title={`${tab.label} (Ctrl+${tab.shortcutKey})`}
          >
            <Icon className="w-3.5 h-3.5" />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
};

export default ModeTabBar;
