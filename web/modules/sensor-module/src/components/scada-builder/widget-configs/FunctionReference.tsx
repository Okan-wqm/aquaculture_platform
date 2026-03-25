import React, { useState, useRef, useEffect } from 'react';
import { HelpCircle, X } from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Function catalog — all available expression functions               */
/* ------------------------------------------------------------------ */

interface FunctionEntry {
  name: string;
  signature: string;
  description: string;
}

interface FunctionGroup {
  label: string;
  functions: FunctionEntry[];
}

/**
 * Static registry of all supported expression functions.
 * Grouped by domain to help operators quickly find what they need.
 * This mirrors the built-in function table in the expression evaluator
 * (engine/expressions/evaluator.ts) — keep both in sync when adding
 * new functions.
 */
const FUNCTION_GROUPS: FunctionGroup[] = [
  {
    label: 'Math',
    functions: [
      { name: 'abs', signature: 'abs(x)', description: 'Absolute value' },
      { name: 'sqrt', signature: 'sqrt(x)', description: 'Square root' },
      { name: 'pow', signature: 'pow(x, y)', description: 'x raised to power y' },
      { name: 'round', signature: 'round(x)', description: 'Round to nearest integer' },
      { name: 'floor', signature: 'floor(x)', description: 'Round down' },
      { name: 'ceil', signature: 'ceil(x)', description: 'Round up' },
      { name: 'log', signature: 'log(x)', description: 'Natural logarithm' },
      { name: 'exp', signature: 'exp(x)', description: 'e raised to power x' },
    ],
  },
  {
    label: 'Range',
    functions: [
      { name: 'min', signature: 'min(a, b)', description: 'Smaller of two values' },
      { name: 'max', signature: 'max(a, b)', description: 'Larger of two values' },
      { name: 'clamp', signature: 'clamp(val, min, max)', description: 'Constrain value within bounds' },
    ],
  },
  {
    label: 'Interpolation',
    functions: [
      { name: 'lerp', signature: 'lerp(a, b, t)', description: 'Linear interpolation (t: 0..1)' },
      { name: 'map', signature: 'map(val, inMin, inMax, outMin, outMax)', description: 'Rescale from one range to another' },
    ],
  },
  {
    label: 'Logic',
    functions: [
      { name: 'if', signature: 'if(cond, then, else)', description: 'Conditional value selection' },
      { name: 'bool', signature: 'bool(x)', description: 'Convert to boolean (0/1)' },
    ],
  },
  {
    label: 'Conversion',
    functions: [
      { name: 'deg2rad', signature: 'deg2rad(d)', description: 'Degrees to radians' },
      { name: 'rad2deg', signature: 'rad2deg(r)', description: 'Radians to degrees' },
    ],
  },
];

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

/**
 * Compact reference popup showing all available expression functions
 * with signatures and brief descriptions. Opens from a (?) icon
 * next to the expression editor.
 *
 * Not a full documentation page -- just enough for an operator to
 * find the right function while writing an expression.
 */
export const FunctionReference: React.FC = () => {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  return (
    <div className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="text-gray-400 hover:text-cyan-600 transition-colors"
        title="Function reference"
        aria-label="Function reference"
        data-testid="function-reference-trigger"
      >
        <HelpCircle className="w-4 h-4" />
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Function reference"
          data-testid="function-reference-popover"
          className="absolute right-0 top-6 z-50 w-80 max-h-72 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-xl p-3"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-gray-700 uppercase tracking-wider">
              Available Functions
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-gray-400 hover:text-gray-600"
              aria-label="Close reference"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {FUNCTION_GROUPS.map((group) => (
            <div key={group.label} className="mb-2 last:mb-0" data-testid={`fn-group-${group.label.toLowerCase()}`}>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-1">
                {group.label}
              </div>
              <div className="space-y-0.5">
                {group.functions.map((fn) => (
                  <div key={fn.name} className="flex items-baseline gap-2 text-xs">
                    <code className="font-mono text-cyan-700 whitespace-nowrap" data-testid={`fn-sig-${fn.name}`}>
                      {fn.signature}
                    </code>
                    <span className="text-gray-500 truncate">{fn.description}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
