import React, { useState, useCallback } from 'react';
import { ChevronDown, Zap } from 'lucide-react';
import { ExpressionEditor } from './ExpressionEditor';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

interface ExpressionBindingSectionProps {
  /** Current expression string (undefined = binding disabled) */
  expression: string | undefined;
  /** Called when expression changes; undefined clears the binding */
  onChange: (expression: string | undefined) => void;
  /** Device ID for tag autocomplete */
  deviceId?: string | null;
  /** Current tag values for live preview */
  tagValues?: Record<string, number | string | boolean>;
}

/* ------------------------------------------------------------------ */
/*  Quick example chips                                                 */
/* ------------------------------------------------------------------ */

interface QuickExample {
  label: string;
  expression: string;
}

/**
 * Common expression patterns shown as clickable chips.
 * Helps operators get started without reading documentation.
 * Each example demonstrates a different capability of the engine.
 */
const QUICK_EXAMPLES: QuickExample[] = [
  { label: 'C->F', expression: '${temperature} * 1.8 + 32' },
  { label: 'Clamp', expression: 'clamp(${level}, 0, 100)' },
  { label: 'Binary', expression: '${flow} > 0 ? 1 : 0' },
  { label: 'Rescale', expression: 'map(${pressure}, 0, 10, 0, 100)' },
];

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

/**
 * Collapsible section for adding computed expression binding to any widget.
 * Appears below the tag binding in widget config panels.
 *
 * When active, the expression's computed value overrides the tag value
 * for the widget's primary data binding. This enables derived values
 * like "temperature * 1.8 + 32" (Celsius to Fahrenheit) without
 * creating a server-side computed tag.
 *
 * Architecture: The expression is stored in widget.config.expression.
 * At runtime, useComputedExpression resolves it reactively.
 */
export const ExpressionBindingSection: React.FC<ExpressionBindingSectionProps> = ({
  expression,
  onChange,
  deviceId = null,
  tagValues,
}) => {
  const [expanded, setExpanded] = useState(false);
  const enabled = expression !== undefined;

  const handleToggleEnabled = useCallback(() => {
    if (enabled) {
      // Disabling clears the expression binding
      onChange(undefined);
    } else {
      // Enabling with empty string so editor shows
      onChange('');
    }
  }, [enabled, onChange]);

  const handleExpressionChange = useCallback(
    (newExpr: string) => {
      onChange(newExpr);
    },
    [onChange],
  );

  const handleQuickExample = useCallback(
    (example: QuickExample) => {
      // Enable if not already enabled, then set expression
      onChange(example.expression);
    },
    [onChange],
  );

  return (
    <div className="border-t border-gray-100 pt-2">
      {/* Collapsible header */}
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-center gap-2 text-xs font-medium text-gray-600 hover:text-gray-800 transition-colors"
        data-testid="expression-section-toggle"
      >
        <ChevronDown
          className={`w-3.5 h-3.5 transition-transform ${expanded ? '' : '-rotate-90'}`}
        />
        <Zap className="w-3.5 h-3.5 text-amber-500" />
        <span>Computed Expression</span>
        {enabled && (
          <span className="ml-auto text-[10px] text-cyan-600 font-semibold uppercase">
            Active
          </span>
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="mt-2 space-y-2">
          {/* Enable/disable toggle */}
          <div className="flex items-center gap-2">
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={enabled}
                onChange={handleToggleEnabled}
                className="sr-only peer"
                data-testid="expression-enable-toggle"
              />
              <div className="w-8 h-4 bg-gray-200 peer-focus:ring-2 peer-focus:ring-cyan-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-cyan-500" />
            </label>
            <span className="text-xs text-gray-500">
              {enabled ? 'Expression overrides tag value' : 'Direct tag binding'}
            </span>
          </div>

          {/* Help text */}
          <p className="text-[10px] text-gray-400 leading-relaxed">
            Override tag value with a computed expression. Use <code className="font-mono text-gray-500">${'{tagName}'}</code> for tag references.
          </p>

          {/* Expression editor (only when enabled) */}
          {enabled && (
            <>
              <ExpressionEditor
                expression={expression || ''}
                onChange={handleExpressionChange}
                deviceId={deviceId}
                tagValues={tagValues}
              />

              {/* Quick example chips */}
              <div className="flex flex-wrap gap-1">
                <span className="text-[10px] text-gray-400 mr-1 leading-5">Examples:</span>
                {QUICK_EXAMPLES.map((ex) => (
                  <button
                    key={ex.label}
                    type="button"
                    onClick={() => handleQuickExample(ex)}
                    className="px-2 py-0.5 text-[10px] font-mono text-gray-600 bg-gray-50 border border-gray-200 rounded hover:bg-cyan-50 hover:border-cyan-300 hover:text-cyan-700 transition-colors"
                    title={ex.expression}
                    data-testid={`quick-example-${ex.label.toLowerCase()}`}
                  >
                    {ex.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
