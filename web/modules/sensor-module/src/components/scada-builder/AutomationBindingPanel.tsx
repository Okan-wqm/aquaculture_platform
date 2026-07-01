/**
 * AutomationBindingPanel
 *
 * Panel for binding automation programs and matching tags to a SCADA package.
 * Rendered in the "Automation" tab of PropertiesPanel.
 */

import React, { useState, useMemo } from 'react';
import { Plus, Trash2, Link, Unlink, Zap, ChevronDown, ChevronRight, Check, AlertTriangle, Search } from 'lucide-react';
import { useScadaPackageStore } from '../../store/scada';
import { useAutomationPrograms, useAutomationProgramVariables } from '../../hooks/useAutomationPrograms';
import { getStatusColor, getStatusText, ProgramStatus } from '../../utils/automation.utils';
import type { AutomationBinding, VariableBinding } from '../../types/scada-package.types';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const ScopeLabel: React.FC<{ scope: VariableBinding['scope'] }> = ({ scope }) => {
  const colors = {
    INPUT: 'bg-blue-100 text-blue-700',
    OUTPUT: 'bg-orange-100 text-orange-700',
    INOUT: 'bg-purple-100 text-purple-700',
  };
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${colors[scope]}`}>
      {scope}
    </span>
  );
};

// ---------------------------------------------------------------------------
// Widget Picker Dropdown
// ---------------------------------------------------------------------------

interface WidgetPickerProps {
  variableTag: string;
  onSelect: (widgetId: string, tag: string) => void;
  onClose: () => void;
}

const WidgetPicker: React.FC<WidgetPickerProps> = ({ variableTag, onSelect, onClose }) => {
  const screens = useScadaPackageStore((s) => s.screens);
  const [search, setSearch] = useState('');

  const allWidgets = useMemo(() => {
    const result: { widgetId: string; label: string; tag: string | null; widgetType: string; screenName: string }[] = [];
    for (const screen of screens) {
      for (const w of screen.widgets) {
        const tag = (w.config.tagName as string | undefined) || (w.config.tag as string | undefined) || null;
        const label = (w.config.label as string | undefined) || w.widgetType;
        result.push({ widgetId: w.id, label, tag, widgetType: w.widgetType, screenName: screen.name });
      }
    }
    return result;
  }, [screens]);

  const filtered = search
    ? allWidgets.filter(
        (w) =>
          w.label.toLowerCase().includes(search.toLowerCase()) ||
          w.widgetType.toLowerCase().includes(search.toLowerCase()) ||
          (w.tag && w.tag.toLowerCase().includes(search.toLowerCase())),
      )
    : allWidgets;

  return (
    <div className="absolute right-0 top-full mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-50 max-h-60 overflow-hidden flex flex-col">
      <div className="p-2 border-b border-gray-100">
        <div className="flex items-center gap-1.5 px-2 py-1 bg-gray-50 rounded border border-gray-200">
          <Search className="w-3 h-3 text-gray-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search widget..."
            className="flex-1 text-xs bg-transparent outline-hidden"
            autoFocus
          />
        </div>
      </div>
      <div className="overflow-y-auto flex-1">
        {filtered.length === 0 ? (
          <p className="text-xs text-gray-500 text-center py-4">
            {allWidgets.length === 0 ? 'No widgets on screens' : 'No results found'}
          </p>
        ) : (
          filtered.map((w) => (
            <button
              key={w.widgetId}
              onClick={() => { onSelect(w.widgetId, variableTag); onClose(); }}
              className="w-full text-left px-3 py-2 text-xs hover:bg-cyan-50 flex items-center gap-2 border-b border-gray-50 last:border-0"
            >
              <div className="flex-1 min-w-0">
                <span className="font-medium text-gray-700 truncate block">{w.label}</span>
                {w.tag && (
                  <span className="text-[10px] text-cyan-600 font-mono truncate block">tag: {w.tag}</span>
                )}
              </div>
              <span className="text-gray-500 truncate text-[10px] shrink-0">{w.widgetType}</span>
            </button>
          ))
        )}
      </div>
      <div className="p-1.5 border-t border-gray-100">
        <button onClick={onClose} className="w-full text-xs text-gray-500 hover:text-gray-700 py-1">
          Close
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Program Selector Modal
// ---------------------------------------------------------------------------

interface ProgramSelectorProps {
  onSelect: (programId: string) => void;
  onClose: () => void;
  existingProgramIds: string[];
}

const ProgramSelector: React.FC<ProgramSelectorProps> = ({ onSelect, onClose, existingProgramIds }) => {
  const { data, isLoading } = useAutomationPrograms();
  const programs = data?.automationPrograms || [];
  const available = programs.filter((p) => !existingProgramIds.includes(p.id));

  return (
    <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 max-h-60 overflow-hidden flex flex-col">
      <div className="px-3 py-2 border-b border-gray-100">
        <h5 className="text-xs font-medium text-gray-700">Select Automation Program</h5>
      </div>
      <div className="overflow-y-auto flex-1">
        {isLoading ? (
          <p className="text-xs text-gray-500 text-center py-4">Loading...</p>
        ) : available.length === 0 ? (
          <p className="text-xs text-gray-500 text-center py-4">
            {programs.length === 0 ? 'No approved programs' : 'All programs added'}
          </p>
        ) : (
          available.map((p) => (
            <button
              key={p.id}
              onClick={() => { onSelect(p.id); onClose(); }}
              className="w-full text-left px-3 py-2.5 hover:bg-cyan-50 border-b border-gray-50 last:border-0"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-gray-800">{p.programName}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${getStatusColor(p.status)}`}>
                  {getStatusText(p.status)}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[10px] text-gray-500 font-mono">{p.programCode}</span>
                <span className="text-[10px] text-gray-500">{p.variableCount} variable{p.variableCount !== 1 ? 's' : ''}</span>
              </div>
            </button>
          ))
        )}
      </div>
      <div className="p-1.5 border-t border-gray-100">
        <button onClick={onClose} className="w-full text-xs text-gray-500 hover:text-gray-700 py-1">
          Cancel
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// ProgramCard with variable bindings
// ---------------------------------------------------------------------------

interface PendingProgram {
  programId: string;
  loading: boolean;
}

const ProgramCard: React.FC<{ binding: AutomationBinding }> = ({ binding }) => {
  const [expanded, setExpanded] = useState(true);
  const [pickerVarId, setPickerVarId] = useState<string | null>(null);
  const removeAutomationProgram = useScadaPackageStore((s) => s.removeAutomationProgram);
  const bindVariableToWidgetAndSetTag = useScadaPackageStore((s) => s.bindVariableToWidgetAndSetTag);
  const unbindVariable = useScadaPackageStore((s) => s.unbindVariable);

  const boundCount = binding.variableBindings.filter((v) => v.boundWidgetId).length;
  const totalCount = binding.variableBindings.length;

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 bg-gray-50 flex items-center gap-2">
        <button onClick={() => setExpanded(!expanded)} className="text-gray-500">
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-gray-800 truncate">{binding.programName}</div>
          <span className="text-[10px] text-gray-500 font-mono">{binding.programCode}</span>
        </div>
        <span className="text-[10px] text-gray-500">
          {boundCount}/{totalCount}
        </span>
        <button
          onClick={() => removeAutomationProgram(binding.programId)}
          className="text-red-400 hover:text-red-600 p-0.5"
          title="Remove program"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Variable List */}
      {expanded && (
        <div className="divide-y divide-gray-100">
          {binding.variableBindings.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-3">No I/O variables</p>
          ) : (
            binding.variableBindings.map((v) => (
              <div key={v.variableId} className="px-3 py-2 relative">
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-xs font-mono text-gray-700">{v.varName}</span>
                  <ScopeLabel scope={v.scope} />
                  <span className="text-[10px] text-gray-500">{v.dataType}</span>
                </div>
                {v.boundWidgetId ? (
                  <div className="flex items-center gap-1.5">
                    <Check className="w-3 h-3 text-green-500" />
                    <span className="text-[10px] text-green-700 font-mono flex-1 truncate">{v.boundTag}</span>
                    <button
                      onClick={() => unbindVariable(binding.programId, v.variableId)}
                      className="text-gray-500 hover:text-red-500 p-0.5"
                      title="Remove binding"
                    >
                      <Unlink className="w-3 h-3" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <AlertTriangle className="w-3 h-3 text-amber-500" />
                    <span className="text-[10px] text-amber-600 flex-1">Unbound</span>
                    <button
                      onClick={() => setPickerVarId(v.variableId)}
                      className="text-xs text-cyan-600 hover:text-cyan-700 flex items-center gap-0.5"
                    >
                      <Link className="w-3 h-3" />
                      Bind
                    </button>
                  </div>
                )}
                {v.ioTagName && (
                  <div className="text-[10px] text-gray-500 mt-0.5">I/O: {v.ioTagName}</div>
                )}

                {pickerVarId === v.variableId && (
                  <WidgetPicker
                    variableTag={v.ioTagName || v.varName}
                    onSelect={(widgetId, tag) =>
                      bindVariableToWidgetAndSetTag(binding.programId, v.variableId, widgetId, tag)
                    }
                    onClose={() => setPickerVarId(null)}
                  />
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main Panel
// ---------------------------------------------------------------------------

export const AutomationBindingPanel: React.FC = () => {
  const automationBindings = useScadaPackageStore((s) => s.automationBindings);
  const addAutomationProgram = useScadaPackageStore((s) => s.addAutomationProgram);
  const autoBindByTag = useScadaPackageStore((s) => s.autoBindByTag);

  const [showSelector, setShowSelector] = useState(false);
  const [pendingProgram, setPendingProgram] = useState<PendingProgram | null>(null);
  const [autoBindResult, setAutoBindResult] = useState<{ matched: number; unmatched: number } | null>(null);

  // When a program is selected from the selector, fetch its variables
  const { data: programData } = useAutomationProgramVariables(pendingProgram?.programId ?? null);

  // Process pending program when data arrives
  React.useEffect(() => {
    if (pendingProgram && programData && !pendingProgram.loading) return;
    if (pendingProgram && programData) {
      const { automationProgram, programVariables } = programData;
      addAutomationProgram(
        automationProgram.id,
        automationProgram.programName,
        automationProgram.programCode,
        programVariables,
      );
      setPendingProgram(null);
    }
  }, [programData, pendingProgram, addAutomationProgram]);

  const handleSelectProgram = (programId: string) => {
    setPendingProgram({ programId, loading: true });
  };

  const handleAutoBind = () => {
    const result = autoBindByTag();
    setAutoBindResult(result);
    setTimeout(() => setAutoBindResult(null), 3000);
  };

  // Summary counts
  const totalBound = automationBindings.reduce(
    (acc, b) => acc + b.variableBindings.filter((v) => v.boundWidgetId).length,
    0,
  );
  const totalUnbound = automationBindings.reduce(
    (acc, b) => acc + b.variableBindings.filter((v) => !v.boundWidgetId).length,
    0,
  );

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-gray-700">Automation Programs</h4>
        <div className="relative">
          <button
            onClick={() => setShowSelector(!showSelector)}
            className="flex items-center gap-1 text-xs text-cyan-600 hover:text-cyan-700"
          >
            <Plus className="w-3 h-3" />
            Add Program
          </button>
          {showSelector && (
            <ProgramSelector
              onSelect={handleSelectProgram}
              onClose={() => setShowSelector(false)}
              existingProgramIds={automationBindings.map((b) => b.programId)}
            />
          )}
        </div>
      </div>

      {/* Auto-bind button */}
      {automationBindings.length > 0 && (
        <button
          onClick={handleAutoBind}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-cyan-700 bg-cyan-50 border border-cyan-200 rounded-lg hover:bg-cyan-100 transition-colors"
        >
          <Zap className="w-3.5 h-3.5" />
          Auto Bind
        </button>
      )}

      {/* Auto-bind result toast */}
      {autoBindResult && (
        <div className="px-3 py-2 text-xs bg-green-50 text-green-700 border border-green-200 rounded-lg">
          {autoBindResult.matched} matched, {autoBindResult.unmatched} unmatched
        </div>
      )}

      {/* Summary */}
      {automationBindings.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <div className="px-3 py-2 bg-green-50 border border-green-100 rounded-lg">
            <div className="flex items-center gap-1 mb-0.5">
              <Check className="w-3 h-3 text-green-600" />
              <span className="text-[10px] text-green-700 font-medium">Bound</span>
            </div>
            <span className="text-sm font-semibold text-green-800">{totalBound}</span>
          </div>
          <div className="px-3 py-2 bg-amber-50 border border-amber-100 rounded-lg">
            <div className="flex items-center gap-1 mb-0.5">
              <AlertTriangle className="w-3 h-3 text-amber-600" />
              <span className="text-[10px] text-amber-700 font-medium">Unbound</span>
            </div>
            <span className="text-sm font-semibold text-amber-800">{totalUnbound}</span>
          </div>
        </div>
      )}

      {/* Program Cards */}
      {automationBindings.length === 0 ? (
        <div className="flex flex-col items-center py-8 text-center text-gray-500">
          <Zap className="w-8 h-8 mb-2 text-gray-500" />
          <p className="text-xs">No programs linked yet</p>
          <p className="text-[10px] mt-1">
            Use "Add Program" to select an automation program
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {automationBindings.map((binding) => (
            <ProgramCard key={binding.programId} binding={binding} />
          ))}
        </div>
      )}

      {/* Pending indicator */}
      {pendingProgram && (
        <div className="text-xs text-gray-500 text-center py-2">
          Loading program variables...
        </div>
      )}
    </div>
  );
};

export default AutomationBindingPanel;
