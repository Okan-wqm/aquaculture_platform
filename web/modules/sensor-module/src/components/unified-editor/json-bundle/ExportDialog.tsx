/**
 * ExportDialog - Modal for exporting automation program as JSON bundle v2.
 *
 * Features:
 *   - Shows program name, variable count, code size
 *   - Option to include/exclude steps and transitions
 *   - Download .json file
 *   - Copy to clipboard
 *   - Preview pane with formatted JSON
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Download,
  Copy,
  Check,
  X,
  FileJson,
  Eye,
  EyeOff,
} from 'lucide-react';
import type {
  STBundleProgram,
  STBundleVariable,
  STBundleStep,
  STBundleTransition,
} from '../../../types/st-editor.types';
import { serializeBundle, formatFileSize } from './bundle.utils';

// ============================================================================
// Types
// ============================================================================

export interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  program: STBundleProgram;
  variables: STBundleVariable[];
  steps: STBundleStep[];
  transitions: STBundleTransition[];
  exportedBy: string;
}

// ============================================================================
// Component
// ============================================================================

const ExportDialog: React.FC<ExportDialogProps> = ({
  open,
  onClose,
  program,
  variables,
  steps,
  transitions,
  exportedBy,
}) => {
  const [includeSteps, setIncludeSteps] = useState(true);
  const [includeTransitions, setIncludeTransitions] = useState(true);
  const [showPreview, setShowPreview] = useState(false);
  const [copied, setCopied] = useState(false);

  const bundleJson = useMemo(() => {
    return serializeBundle(
      program,
      variables,
      includeSteps ? steps : [],
      includeTransitions ? transitions : [],
      exportedBy,
    );
  }, [program, variables, steps, transitions, includeSteps, includeTransitions, exportedBy]);

  const bundleSize = useMemo(() => {
    return new TextEncoder().encode(bundleJson).length;
  }, [bundleJson]);

  const codeSize = useMemo(() => {
    return new TextEncoder().encode(program.structuredTextCode || '').length;
  }, [program.structuredTextCode]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([bundleJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${program.programCode || 'automation'}_bundle.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [bundleJson, program.programCode]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(bundleJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = bundleJson;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [bundleJson]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <div className="flex items-center gap-2">
            <FileJson className="w-5 h-5 text-blue-400" />
            <h2 className="text-sm font-semibold text-gray-100">
              Export JSON Bundle
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-200 rounded"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Program Info */}
          <div className="bg-gray-800 rounded-lg p-3 space-y-2">
            <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider">
              Program
            </h3>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <span className="text-gray-500">Code: </span>
                <span className="text-gray-200 font-mono">
                  {program.programCode}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Name: </span>
                <span className="text-gray-200">{program.programName}</span>
              </div>
              <div>
                <span className="text-gray-500">Type: </span>
                <span className="text-blue-300">{program.programType}</span>
              </div>
              <div>
                <span className="text-gray-500">Mode: </span>
                <span className="text-blue-300">{program.executionMode}</span>
              </div>
            </div>
          </div>

          {/* Statistics */}
          <div className="grid grid-cols-4 gap-2">
            <div className="bg-gray-800 rounded p-2 text-center">
              <div className="text-lg font-semibold text-gray-100">
                {variables.length}
              </div>
              <div className="text-xs text-gray-500">Variables</div>
            </div>
            <div className="bg-gray-800 rounded p-2 text-center">
              <div className="text-lg font-semibold text-gray-100">
                {steps.length}
              </div>
              <div className="text-xs text-gray-500">Steps</div>
            </div>
            <div className="bg-gray-800 rounded p-2 text-center">
              <div className="text-lg font-semibold text-gray-100">
                {transitions.length}
              </div>
              <div className="text-xs text-gray-500">Transitions</div>
            </div>
            <div className="bg-gray-800 rounded p-2 text-center">
              <div className="text-lg font-semibold text-gray-100">
                {formatFileSize(codeSize)}
              </div>
              <div className="text-xs text-gray-500">Code Size</div>
            </div>
          </div>

          {/* Options */}
          <div className="bg-gray-800 rounded-lg p-3 space-y-2">
            <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider">
              Options
            </h3>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={includeSteps}
                onChange={(e) => setIncludeSteps(e.target.checked)}
                className="rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
              />
              Include SFC steps ({steps.length})
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={includeTransitions}
                onChange={(e) => setIncludeTransitions(e.target.checked)}
                className="rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
              />
              Include SFC transitions ({transitions.length})
            </label>
          </div>

          {/* Bundle Size */}
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-500">
              Bundle size: {formatFileSize(bundleSize)}
            </span>
            {bundleSize > 1_048_576 && (
              <span className="text-red-400 text-xs">
                Exceeds 1MB limit
              </span>
            )}
          </div>

          {/* Preview Toggle */}
          <button
            onClick={() => setShowPreview(!showPreview)}
            className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200"
          >
            {showPreview ? (
              <EyeOff className="w-3.5 h-3.5" />
            ) : (
              <Eye className="w-3.5 h-3.5" />
            )}
            {showPreview ? 'Hide' : 'Show'} Preview
          </button>

          {/* Preview Pane */}
          {showPreview && (
            <div className="bg-gray-950 rounded border border-gray-700 p-3 max-h-64 overflow-auto">
              <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap break-all">
                {bundleJson}
              </pre>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-700">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200 rounded"
          >
            Cancel
          </button>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 text-gray-200 rounded"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-green-400" />
                Copied
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                Copy
              </>
            )}
          </button>
          <button
            onClick={handleDownload}
            disabled={bundleSize > 1_048_576}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded"
          >
            <Download className="w-3.5 h-3.5" />
            Download .json
          </button>
        </div>
      </div>
    </div>
  );
};

export default ExportDialog;
