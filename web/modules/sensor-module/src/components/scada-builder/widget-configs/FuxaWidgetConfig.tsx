/**
 * FuxaWidgetConfig - Configuration panel for FUXA community SVG widgets.
 *
 * Provides:
 * 1. SVG file upload with script preservation (NO DOMPurify -- intentional)
 * 2. Auto-parsed variable list with type-appropriate input controls
 * 3. Tag binding for the state machine (drives FUXA 6-state index)
 * 4. State mapping rule editor (tag value -> state index)
 * 5. Per-variable tag bindings for direct data piping
 *
 * Security note: Unlike CustomSvgConfig, this panel does NOT sanitize
 * the uploaded SVG because FUXA widgets require their embedded <script>
 * blocks to function. Security is enforced at render-time by the
 * iframe sandbox attribute (allow-scripts only, no allow-same-origin).
 *
 * File size is still capped at 1MB to prevent oversized SCADA packages.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Upload, Trash2, AlertCircle, Plus, X } from 'lucide-react';
import { parseFuxaExportVariables } from '../fuxa-bridge/types';
import type { FuxaExportVariable, FuxaStateRule } from '../fuxa-bridge/types';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** 1MB cap -- FUXA SVGs with scripts are typically 50-300KB */
const MAX_SVG_SIZE_BYTES = 1024 * 1024;

const INPUT_CLS =
  'w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500';

const CONDITION_OPTIONS: Array<{ value: FuxaStateRule['condition']; label: string }> = [
  { value: 'lt', label: '< Less than' },
  { value: 'lte', label: '<= Less or equal' },
  { value: 'eq', label: '= Equal' },
  { value: 'gte', label: '>= Greater or equal' },
  { value: 'gt', label: '> Greater than' },
  { value: 'between', label: 'Between' },
];

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const FuxaWidgetConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const svgContent = (config.svgContent as string) || '';
  const svgFileName = (config.svgFileName as string) || '';
  const variables = (config.variables as Record<string, string | number | boolean>) || {};
  const tagName = (config.tagName as string) || '';
  const stateRules = (config.stateRules as FuxaStateRule[]) || [];
  const variableTagBindings = (config.variableTagBindings as Record<string, string>) || {};
  const label = (config.label as string) || '';

  // Parse export variables from SVG content for dynamic UI generation
  const exportVariables = useMemo(
    () => parseFuxaExportVariables(svgContent),
    [svgContent],
  );

  /* ---------------------------------------------------------------- */
  /*  File upload handler                                              */
  /* ---------------------------------------------------------------- */

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setUploadError(null);

      // Validate file extension
      if (!file.name.toLowerCase().endsWith('.svg')) {
        setUploadError('Only .svg files are accepted');
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }

      // Size cap to prevent oversized SCADA packages
      if (file.size > MAX_SVG_SIZE_BYTES) {
        setUploadError(
          `File too large (${(file.size / 1024).toFixed(0)}KB). Maximum: ${MAX_SVG_SIZE_BYTES / 1024}KB`,
        );
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }

      const text = await file.text();
      const trimmed = text.trim();

      // Basic SVG validation -- must start with <svg or <?xml
      if (!trimmed.startsWith('<svg') && !trimmed.startsWith('<?xml')) {
        setUploadError('Invalid SVG file. Content must start with <svg> or <?xml>.');
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }

      // Parse variables to build default values map
      const parsed = parseFuxaExportVariables(text);
      const defaultVars: Record<string, string | number | boolean> = {};
      for (const v of parsed) {
        defaultVars[v.id] = v.defaultValue;
      }

      onChange({
        svgContent: text,
        svgFileName: file.name,
        variables: defaultVars,
      });

      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [onChange],
  );

  const handleRemove = useCallback(() => {
    setUploadError(null);
    onChange({
      svgContent: undefined,
      svgFileName: undefined,
      variables: {},
      stateRules: [],
      variableTagBindings: {},
    });
  }, [onChange]);

  /* ---------------------------------------------------------------- */
  /*  Variable value change handler                                    */
  /* ---------------------------------------------------------------- */

  const handleVariableChange = useCallback(
    (varId: string, value: string | number | boolean) => {
      onChange({
        variables: { ...variables, [varId]: value },
      });
    },
    [variables, onChange],
  );

  /* ---------------------------------------------------------------- */
  /*  Variable tag binding handler                                     */
  /* ---------------------------------------------------------------- */

  const handleVariableTagChange = useCallback(
    (varId: string, tag: string) => {
      const updated = { ...variableTagBindings };
      if (tag) {
        updated[varId] = tag;
      } else {
        delete updated[varId];
      }
      onChange({ variableTagBindings: updated });
    },
    [variableTagBindings, onChange],
  );

  /* ---------------------------------------------------------------- */
  /*  State rules handlers                                             */
  /* ---------------------------------------------------------------- */

  const handleAddRule = useCallback(() => {
    const newRule: FuxaStateRule = { condition: 'gte', value: 0, state: 0 };
    onChange({ stateRules: [...stateRules, newRule] });
  }, [stateRules, onChange]);

  const handleRemoveRule = useCallback(
    (index: number) => {
      const updated = stateRules.filter((_, i) => i !== index);
      onChange({ stateRules: updated });
    },
    [stateRules, onChange],
  );

  const handleRuleChange = useCallback(
    (index: number, field: keyof FuxaStateRule, rawValue: string) => {
      const updated = [...stateRules];
      const rule = { ...updated[index] };

      switch (field) {
        case 'condition':
          rule.condition = rawValue as FuxaStateRule['condition'];
          // Reset value format when switching to/from 'between'
          if (rawValue === 'between' && !Array.isArray(rule.value)) {
            rule.value = [0, 100];
          } else if (rawValue !== 'between' && Array.isArray(rule.value)) {
            rule.value = rule.value[0];
          }
          break;
        case 'state':
          rule.state = Math.min(5, Math.max(0, parseInt(rawValue, 10) || 0)) as FuxaStateRule['state'];
          break;
        case 'value':
          if (rule.condition === 'between') {
            // Parse "min,max" format
            const parts = rawValue.split(',').map((s) => parseFloat(s.trim()) || 0);
            rule.value = [parts[0] ?? 0, parts[1] ?? 100];
          } else {
            rule.value = parseFloat(rawValue) || 0;
          }
          break;
      }

      updated[index] = rule;
      onChange({ stateRules: updated });
    },
    [stateRules, onChange],
  );

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="space-y-3">
      {/* Label */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Label</label>
        <input
          type="text"
          value={label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="FUXA Widget"
          className={INPUT_CLS}
        />
      </div>

      {/* SVG Upload */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">
          FUXA SVG File
          <span className="text-[10px] text-amber-600 ml-1">(scripts preserved)</span>
        </label>
        {svgContent ? (
          <div className="flex items-center justify-between px-3 py-2 bg-green-50 border border-green-200 rounded-lg">
            <span className="text-xs text-green-700 truncate">
              {svgFileName || 'fuxa-widget.svg'}
            </span>
            <button
              onClick={handleRemove}
              className="text-red-400 hover:text-red-600 ml-2"
              data-testid="fuxa-remove-svg"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ) : (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full flex items-center justify-center gap-2 px-3 py-3 border-2 border-dashed border-gray-300 rounded-lg text-xs text-gray-500 hover:border-cyan-400 hover:text-cyan-600 transition-colors"
            data-testid="fuxa-upload-btn"
          >
            <Upload size={14} />
            Upload FUXA SVG
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".svg"
          className="hidden"
          onChange={handleFileSelect}
          data-testid="fuxa-file-input"
        />
        {uploadError && (
          <div className="flex items-center gap-1.5 mt-1.5 px-2 py-1.5 bg-red-50 border border-red-200 rounded text-xs text-red-600">
            <AlertCircle size={12} className="flex-shrink-0" />
            <span>{uploadError}</span>
          </div>
        )}
      </div>

      {/* Export Variables */}
      {exportVariables.length > 0 && (
        <div className="pt-2 border-t border-gray-100">
          <label className="text-xs text-gray-500 font-medium mb-2 block">
            Variables ({exportVariables.length})
          </label>
          <div className="space-y-2">
            {exportVariables.map((v) => (
              <VariableInput
                key={v.id}
                variable={v}
                value={variables[v.id] ?? v.defaultValue}
                tagBinding={variableTagBindings[v.id] || ''}
                onChange={handleVariableChange}
                onTagChange={handleVariableTagChange}
              />
            ))}
          </div>
        </div>
      )}

      {/* State Machine Tag Binding */}
      <div className="pt-2 border-t border-gray-100">
        <label className="text-xs text-gray-500 font-medium mb-2 block">
          State Machine
        </label>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Tag Name</label>
          <input
            type="text"
            value={tagName}
            onChange={(e) => onChange({ tagName: e.target.value })}
            placeholder="sensor.temperature"
            className={INPUT_CLS}
            data-testid="fuxa-state-tag"
          />
        </div>
      </div>

      {/* State Rules */}
      {tagName && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs text-gray-500 font-medium">State Rules</label>
            <button
              onClick={handleAddRule}
              className="flex items-center gap-1 text-xs text-cyan-600 hover:text-cyan-700"
              data-testid="fuxa-add-rule"
            >
              <Plus size={12} />
              Add Rule
            </button>
          </div>
          {stateRules.map((rule, idx) => (
            <StateRuleRow
              key={idx}
              rule={rule}
              index={idx}
              onChange={handleRuleChange}
              onRemove={handleRemoveRule}
            />
          ))}
          {stateRules.length === 0 && (
            <p className="text-[10px] text-gray-400">
              No rules defined. Add rules to map tag values to FUXA states (0-5).
            </p>
          )}
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Variable input sub-component                                       */
/* ------------------------------------------------------------------ */

interface VariableInputProps {
  variable: FuxaExportVariable;
  value: string | number | boolean;
  tagBinding: string;
  onChange: (varId: string, value: string | number | boolean) => void;
  onTagChange: (varId: string, tag: string) => void;
}

const VariableInput: React.FC<VariableInputProps> = ({
  variable,
  value,
  tagBinding,
  onChange,
  onTagChange,
}) => {
  const renderInput = () => {
    switch (variable.type) {
      case 'number':
        return (
          <input
            type="number"
            value={value as number}
            onChange={(e) => onChange(variable.id, parseFloat(e.target.value) || 0)}
            className={INPUT_CLS}
            data-testid={`fuxa-var-${variable.id}`}
          />
        );
      case 'boolean':
        return (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={value as boolean}
              onChange={(e) => onChange(variable.id, e.target.checked)}
              className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
              data-testid={`fuxa-var-${variable.id}`}
            />
            <span className="text-xs text-gray-600">{value ? 'True' : 'False'}</span>
          </label>
        );
      case 'color':
        return (
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={String(value)}
              onChange={(e) => onChange(variable.id, e.target.value)}
              className="w-8 h-8 rounded border border-gray-300 cursor-pointer"
              data-testid={`fuxa-var-${variable.id}`}
            />
            <input
              type="text"
              value={String(value)}
              onChange={(e) => onChange(variable.id, e.target.value)}
              className={`${INPUT_CLS} flex-1`}
              placeholder="#000000"
            />
          </div>
        );
      case 'string':
      default:
        return (
          <input
            type="text"
            value={String(value)}
            onChange={(e) => onChange(variable.id, e.target.value)}
            className={INPUT_CLS}
            data-testid={`fuxa-var-${variable.id}`}
          />
        );
    }
  };

  return (
    <div className="p-2 bg-gray-50 rounded-lg">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-gray-700">{variable.label}</span>
        <span className="text-[10px] text-gray-400 font-mono">{variable.type}</span>
      </div>
      {renderInput()}
      {/* Per-variable tag binding */}
      <div className="mt-1.5">
        <input
          type="text"
          value={tagBinding}
          onChange={(e) => onTagChange(variable.id, e.target.value)}
          placeholder="Bind to tag..."
          className="w-full px-2 py-1 text-[11px] border border-gray-200 rounded focus:ring-1 focus:ring-cyan-500 focus:border-cyan-500"
          data-testid={`fuxa-var-tag-${variable.id}`}
        />
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  State rule row sub-component                                       */
/* ------------------------------------------------------------------ */

interface StateRuleRowProps {
  rule: FuxaStateRule;
  index: number;
  onChange: (index: number, field: keyof FuxaStateRule, value: string) => void;
  onRemove: (index: number) => void;
}

const StateRuleRow: React.FC<StateRuleRowProps> = ({ rule, index, onChange, onRemove }) => {
  const valueDisplay = Array.isArray(rule.value)
    ? `${rule.value[0]},${rule.value[1]}`
    : String(rule.value);

  return (
    <div className="flex items-center gap-1.5 p-1.5 bg-gray-50 rounded" data-testid={`fuxa-rule-${index}`}>
      {/* Condition */}
      <select
        value={rule.condition}
        onChange={(e) => onChange(index, 'condition', e.target.value)}
        className="px-1.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-cyan-500"
      >
        {CONDITION_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {/* Value */}
      <input
        type="text"
        value={valueDisplay}
        onChange={(e) => onChange(index, 'value', e.target.value)}
        className="w-20 px-1.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-cyan-500"
        placeholder={rule.condition === 'between' ? '0,100' : '0'}
      />

      {/* Arrow */}
      <span className="text-xs text-gray-400">{'\u2192'}</span>

      {/* State index */}
      <select
        value={rule.state}
        onChange={(e) => onChange(index, 'state', e.target.value)}
        className="px-1.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-cyan-500"
      >
        {[0, 1, 2, 3, 4, 5].map((s) => (
          <option key={s} value={s}>
            State {s}
          </option>
        ))}
      </select>

      {/* Remove */}
      <button
        onClick={() => onRemove(index)}
        className="text-red-400 hover:text-red-600 ml-auto"
      >
        <X size={12} />
      </button>
    </div>
  );
};
