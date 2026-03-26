/**
 * Dynamically generates a configuration panel from parsed FUXA export variables.
 * No hardcoded per-widget UI -- the panel adapts to whatever variables
 * the FUXA widget exports.
 *
 * Renders grouped sections:
 * 1. State Colors: 6 color pickers for state0-state5 (collapsible)
 * 2. Appearance: shade percentages, padding, aspect ratio
 * 3. Transform: rotation, offset, flip toggles
 * 4. Custom: any widget-specific variables
 *
 * Each variable renders as the appropriate input type:
 * - number  -> number input with step
 * - string  -> text input
 * - boolean -> checkbox/toggle
 * - color   -> color picker (with alpha support)
 *
 * Architecture: This component is purely presentational. It receives a
 * flat record of variable values and fires onChange with incremental
 * updates. The parent (PropertiesPanel) is responsible for merging
 * updates into the widget's config and persisting.
 */

import React, { useState, useCallback, useMemo } from 'react';
import { ChevronDown, ChevronRight, Palette, Eye, RotateCw, Settings2 } from 'lucide-react';
import type { FuxaExportVariable, FuxaVarGroup, FuxaVarType } from '../fuxa-bridge/FuxaExportParser';

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface FuxaAutoConfigPanelProps {
  /** Parsed export variables from FuxaExportParser */
  variables: FuxaExportVariable[];
  /**
   * Current values for each variable.
   * Keyed by variable ID (e.g. '_pc_state0').
   * Missing keys fall back to the variable's defaultValue.
   */
  values: Record<string, string | number | boolean>;
  /** Called when the user changes a variable value */
  onChange: (updates: Record<string, string | number | boolean>) => void;
}

/* ------------------------------------------------------------------ */
/*  Section metadata                                                   */
/* ------------------------------------------------------------------ */

interface SectionMeta {
  key: FuxaVarGroup;
  label: string;
  icon: React.ReactNode;
}

const SECTION_META: SectionMeta[] = [
  { key: 'stateColor', label: 'State Colors', icon: <Palette className="w-3.5 h-3.5" /> },
  { key: 'appearance', label: 'Appearance', icon: <Eye className="w-3.5 h-3.5" /> },
  { key: 'transform', label: 'Transform', icon: <RotateCw className="w-3.5 h-3.5" /> },
  { key: 'custom', label: 'Custom', icon: <Settings2 className="w-3.5 h-3.5" /> },
];

/* ------------------------------------------------------------------ */
/*  Input components per type                                          */
/* ------------------------------------------------------------------ */

const INPUT_CLASS =
  'w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500';

interface FieldProps {
  variable: FuxaExportVariable;
  value: string | number | boolean;
  onUpdate: (id: string, value: string | number | boolean) => void;
}

/** Number input with step 1 for integers, 0.1 for potential floats */
const NumberField: React.FC<FieldProps> = ({ variable, value, onUpdate }) => {
  const numVal = typeof value === 'number' ? value : Number(value) || 0;
  // Shade/angle values typically use integer steps; detect from default
  const step = Number.isInteger(variable.defaultValue as number) ? 1 : 0.1;

  return (
    <input
      type="number"
      value={numVal}
      step={step}
      onChange={(e) => onUpdate(variable.id, Number(e.target.value))}
      className={INPUT_CLASS}
      aria-label={variable.label}
      data-testid={`fuxa-field-${variable.id}`}
    />
  );
};

/** Text input for string variables */
const StringField: React.FC<FieldProps> = ({ variable, value, onUpdate }) => (
  <input
    type="text"
    value={String(value)}
    onChange={(e) => onUpdate(variable.id, e.target.value)}
    className={INPUT_CLASS}
    aria-label={variable.label}
    data-testid={`fuxa-field-${variable.id}`}
  />
);

/** Checkbox toggle for boolean variables */
const BooleanField: React.FC<FieldProps> = ({ variable, value, onUpdate }) => (
  <label
    className="flex items-center gap-2 cursor-pointer"
    data-testid={`fuxa-field-${variable.id}`}
  >
    <input
      type="checkbox"
      checked={Boolean(value)}
      onChange={(e) => onUpdate(variable.id, e.target.checked)}
      className="w-4 h-4 text-cyan-600 border-gray-300 rounded focus:ring-cyan-500"
    />
    <span className="text-sm text-gray-700">{variable.label}</span>
  </label>
);

/**
 * Color picker field.
 * Uses native <input type="color"> for basic hex selection.
 * Also shows the raw hex value as editable text for alpha-channel
 * colors (8-digit hex) which the native picker does not support.
 */
const ColorField: React.FC<FieldProps> = ({ variable, value, onUpdate }) => {
  const strVal = String(value);
  // Native color input only supports 6-digit hex -- truncate for display
  const shortHex = strVal.length > 7 ? strVal.slice(0, 7) : strVal;

  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={shortHex}
        onChange={(e) => {
          // Preserve alpha suffix if original value had 8-digit hex
          const alpha = strVal.length > 7 ? strVal.slice(7) : '';
          onUpdate(variable.id, e.target.value + alpha);
        }}
        className="w-8 h-8 rounded cursor-pointer border border-gray-300"
        aria-label={variable.label}
      />
      <input
        type="text"
        value={strVal}
        onChange={(e) => onUpdate(variable.id, e.target.value)}
        className="flex-1 px-2 py-1 text-xs font-mono border border-gray-300 rounded focus:ring-1 focus:ring-cyan-500"
        data-testid={`fuxa-field-${variable.id}`}
      />
    </div>
  );
};

/** Registry mapping variable type to the appropriate field component */
const FIELD_COMPONENTS: Record<FuxaVarType, React.FC<FieldProps>> = {
  number: NumberField,
  string: StringField,
  boolean: BooleanField,
  color: ColorField,
};

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export const FuxaAutoConfigPanel: React.FC<FuxaAutoConfigPanelProps> = ({
  variables,
  values,
  onChange,
}) => {
  // Track which sections are expanded -- all expanded by default
  const [expanded, setExpanded] = useState<Set<FuxaVarGroup>>(
    () => new Set<FuxaVarGroup>(['stateColor', 'appearance', 'transform', 'custom']),
  );

  // Group variables by their semantic group
  const grouped = useMemo(() => {
    const map = new Map<FuxaVarGroup, FuxaExportVariable[]>();
    for (const v of variables) {
      if (!map.has(v.group)) map.set(v.group, []);
      map.get(v.group)!.push(v);
    }
    return map;
  }, [variables]);

  const toggleSection = useCallback((key: FuxaVarGroup) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleUpdate = useCallback(
    (id: string, value: string | number | boolean) => {
      onChange({ [id]: value });
    },
    [onChange],
  );

  // Resolve the effective value for a variable, falling back to default
  const resolveValue = useCallback(
    (v: FuxaExportVariable): string | number | boolean => {
      return v.id in values ? values[v.id] : v.defaultValue;
    },
    [values],
  );

  if (variables.length === 0) {
    return (
      <div className="px-3 py-4 text-center text-xs text-gray-500">
        This FUXA widget has no configurable variables.
      </div>
    );
  }

  return (
    <div className="space-y-1" data-testid="fuxa-auto-config-panel">
      {SECTION_META.map((section) => {
        const vars = grouped.get(section.key);
        if (!vars || vars.length === 0) return null;

        const isOpen = expanded.has(section.key);

        return (
          <div key={section.key} className="border border-gray-200 rounded-lg overflow-hidden">
            {/* Section header -- click to collapse/expand */}
            <button
              onClick={() => toggleSection(section.key)}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold text-gray-700 bg-gray-50 hover:bg-gray-100 transition-colors"
              aria-expanded={isOpen}
              data-testid={`fuxa-section-${section.key}`}
            >
              {isOpen
                ? <ChevronDown className="w-3 h-3 text-gray-500" />
                : <ChevronRight className="w-3 h-3 text-gray-500" />
              }
              {section.icon}
              <span>{section.label}</span>
              <span className="ml-auto text-[10px] text-gray-400 font-normal">
                {vars.length}
              </span>
            </button>

            {/* Section body -- renders each variable with the appropriate input */}
            {isOpen && (
              <div className="px-3 py-2 space-y-2.5">
                {vars.map((v) => {
                  const FieldComponent = FIELD_COMPONENTS[v.type];
                  // Boolean fields render the label inline with the checkbox
                  if (v.type === 'boolean') {
                    return (
                      <FieldComponent
                        key={v.id}
                        variable={v}
                        value={resolveValue(v)}
                        onUpdate={handleUpdate}
                      />
                    );
                  }

                  return (
                    <div key={v.id}>
                      <label className="block text-xs text-gray-500 mb-1">
                        {v.label}
                      </label>
                      <FieldComponent
                        variable={v}
                        value={resolveValue(v)}
                        onUpdate={handleUpdate}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default FuxaAutoConfigPanel;
