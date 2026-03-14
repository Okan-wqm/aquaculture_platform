/**
 * ImportDialog - Modal for importing JSON bundle v2.
 *
 * Features:
 *   - Drag & drop zone for .json files
 *   - File input fallback
 *   - Paste from clipboard support
 *   - Validation feedback (errors shown inline)
 *   - Preview of program to import
 *   - Security warnings for suspicious content
 */

import React, { useCallback, useRef, useState } from 'react';
import {
  Upload,
  Clipboard,
  AlertTriangle,
  CheckCircle,
  XCircle,
  X,
  FileJson,
  Shield,
  Loader2,
} from 'lucide-react';
import type { STBundle } from '../../../types/st-editor.types';
import {
  deserializeBundle,
  formatFileSize,
  type BundleValidationResult,
} from './bundle.utils';

// ============================================================================
// Types
// ============================================================================

export interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  onImport: (bundle: STBundle) => void;
}

type ImportStage = 'input' | 'validating' | 'preview' | 'error';

// ============================================================================
// Component
// ============================================================================

const ImportDialog: React.FC<ImportDialogProps> = ({
  open,
  onClose,
  onImport,
}) => {
  const [stage, setStage] = useState<ImportStage>('input');
  const [dragOver, setDragOver] = useState(false);
  const [result, setResult] = useState<BundleValidationResult | null>(null);
  const [rawJson, setRawJson] = useState('');
  const [fileName, setFileName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setStage('input');
    setResult(null);
    setRawJson('');
    setFileName('');
  }, []);

  const processJson = useCallback((json: string, name?: string) => {
    if (name) setFileName(name);
    setRawJson(json);
    setStage('validating');

    // Use setTimeout to allow the UI to show "validating" state
    setTimeout(() => {
      const validationResult = deserializeBundle(json);
      setResult(validationResult);
      setStage(validationResult.valid ? 'preview' : 'error');
    }, 50);
  }, []);

  const handleFile = useCallback(
    (file: File) => {
      if (file.size > 1_048_576) {
        setResult({
          valid: false,
          errors: [{ field: '_size', message: `File too large: ${formatFileSize(file.size)} (max 1MB)` }],
          warnings: [],
        });
        setStage('error');
        return;
      }

      if (!file.name.endsWith('.json')) {
        setResult({
          valid: false,
          errors: [{ field: '_type', message: 'Only .json files are accepted' }],
          warnings: [],
        });
        setStage('error');
        return;
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result;
        if (typeof text === 'string') {
          processJson(text, file.name);
        }
      };
      reader.onerror = () => {
        setResult({
          valid: false,
          errors: [{ field: '_read', message: 'Failed to read file' }],
          warnings: [],
        });
        setStage('error');
      };
      reader.readAsText(file);
    },
    [processJson],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        processJson(text, 'clipboard');
      }
    } catch {
      // Clipboard API may not be available
      setResult({
        valid: false,
        errors: [{ field: '_clipboard', message: 'Cannot access clipboard. Try drag & drop or file input.' }],
        warnings: [],
      });
      setStage('error');
    }
  }, [processJson]);

  const handleImport = useCallback(() => {
    if (result?.valid && result.bundle) {
      onImport(result.bundle);
      onClose();
      reset();
    }
  }, [result, onImport, onClose, reset]);

  const handleClose = useCallback(() => {
    onClose();
    reset();
  }, [onClose, reset]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <div className="flex items-center gap-2">
            <Upload className="w-5 h-5 text-blue-400" />
            <h2 className="text-sm font-semibold text-gray-100">
              Import JSON Bundle
            </h2>
          </div>
          <button
            onClick={handleClose}
            className="p-1 text-gray-500 hover:text-gray-200 rounded"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Input Stage */}
          {stage === 'input' && (
            <>
              {/* Drop Zone */}
              <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onClick={() => fileInputRef.current?.click()}
                className={`
                  border-2 border-dashed rounded-lg p-8 text-center cursor-pointer
                  transition-colors
                  ${
                    dragOver
                      ? 'border-blue-400 bg-blue-900/20'
                      : 'border-gray-600 hover:border-gray-500 bg-gray-800/50'
                  }
                `}
              >
                <FileJson
                  className={`w-10 h-10 mx-auto mb-3 ${
                    dragOver ? 'text-blue-400' : 'text-gray-500'
                  }`}
                />
                <p className="text-sm text-gray-500">
                  Drag & drop a .json file here
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  or click to browse (max 1MB)
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  onChange={handleFileInput}
                  className="hidden"
                />
              </div>

              {/* Paste from Clipboard */}
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-gray-700" />
                <span className="text-xs text-gray-500">or</span>
                <div className="flex-1 h-px bg-gray-700" />
              </div>

              <button
                onClick={handlePaste}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-800 hover:bg-gray-750 border border-gray-700 rounded-lg text-sm text-gray-500"
              >
                <Clipboard className="w-4 h-4" />
                Paste from Clipboard
              </button>
            </>
          )}

          {/* Validating Stage */}
          {stage === 'validating' && (
            <div className="flex flex-col items-center py-8 gap-3">
              <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
              <p className="text-sm text-gray-500">Validating bundle...</p>
            </div>
          )}

          {/* Error Stage */}
          {stage === 'error' && result && (
            <>
              <div className="bg-red-900/20 border border-red-800 rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                  <h3 className="text-sm font-medium text-red-300">
                    Validation Failed
                  </h3>
                </div>
                <ul className="space-y-1 ml-6">
                  {result.errors.map((err, i) => (
                    <li key={i} className="text-xs text-red-300">
                      <span className="text-red-500 font-mono">
                        {err.field}
                      </span>
                      : {err.message}
                    </li>
                  ))}
                </ul>
              </div>

              {result.warnings.length > 0 && (
                <SecurityWarnings warnings={result.warnings} />
              )}

              <button
                onClick={reset}
                className="w-full px-4 py-2 text-sm bg-gray-800 hover:bg-gray-700 text-gray-500 rounded"
              >
                Try Again
              </button>
            </>
          )}

          {/* Preview Stage */}
          {stage === 'preview' && result?.bundle && (
            <>
              {/* Success Banner */}
              <div className="bg-green-900/20 border border-green-800 rounded-lg p-3">
                <div className="flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-green-400" />
                  <span className="text-sm text-green-300">
                    Bundle validated successfully
                    {fileName && (
                      <span className="text-green-500 ml-1">
                        ({fileName})
                      </span>
                    )}
                  </span>
                </div>
              </div>

              {/* Security Warnings */}
              {result.warnings.length > 0 && (
                <SecurityWarnings warnings={result.warnings} />
              )}

              {/* Program Preview */}
              <div className="bg-gray-800 rounded-lg p-3 space-y-2">
                <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Program Details
                </h3>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-gray-500">Code: </span>
                    <span className="text-gray-200 font-mono">
                      {result.bundle.program.programCode}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">Name: </span>
                    <span className="text-gray-200">
                      {result.bundle.program.programName}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">Type: </span>
                    <span className="text-blue-300">
                      {result.bundle.program.programType}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">Mode: </span>
                    <span className="text-blue-300">
                      {result.bundle.program.executionMode}
                    </span>
                  </div>
                </div>
              </div>

              {/* Statistics */}
              <div className="grid grid-cols-4 gap-2">
                <StatBox
                  label="Variables"
                  value={result.bundle.variables.length}
                />
                <StatBox label="Steps" value={result.bundle.steps.length} />
                <StatBox
                  label="Transitions"
                  value={result.bundle.transitions.length}
                />
                <StatBox
                  label="Code Size"
                  value={formatFileSize(
                    new TextEncoder().encode(
                      result.bundle.program.structuredTextCode,
                    ).length,
                  )}
                />
              </div>

              {/* Code Preview */}
              {result.bundle.program.structuredTextCode && (
                <div className="bg-gray-800 rounded-lg p-3 space-y-2">
                  <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Code Preview
                  </h3>
                  <pre className="text-xs text-gray-500 font-mono bg-gray-950 rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap">
                    {result.bundle.program.structuredTextCode.slice(0, 500)}
                    {result.bundle.program.structuredTextCode.length > 500 &&
                      '\n...'}
                  </pre>
                </div>
              )}

              {/* Export Info */}
              <div className="text-xs text-gray-500 flex items-center gap-4">
                <span>
                  Exported: {new Date(result.bundle.exportedAt).toLocaleString()}
                </span>
                <span>By: {result.bundle.exportedBy}</span>
                <span>
                  From: {result.bundle.exportedFrom.platform}{' '}
                  {result.bundle.exportedFrom.version}
                </span>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-700">
          <div className="text-xs text-gray-500">
            {rawJson && (
              <span>
                Bundle size: {formatFileSize(new TextEncoder().encode(rawJson).length)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleClose}
              className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-200 rounded"
            >
              Cancel
            </button>
            {stage === 'preview' && result?.valid && (
              <button
                onClick={handleImport}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded"
              >
                <Upload className="w-3.5 h-3.5" />
                Import Program
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Sub-Components
// ============================================================================

const SecurityWarnings: React.FC<{ warnings: string[] }> = ({ warnings }) => (
  <div className="bg-yellow-900/20 border border-yellow-800 rounded-lg p-3 space-y-1.5">
    <div className="flex items-center gap-2">
      <Shield className="w-4 h-4 text-yellow-400 flex-shrink-0" />
      <h3 className="text-sm font-medium text-yellow-300">
        Security Warnings
      </h3>
    </div>
    <ul className="space-y-1 ml-6">
      {warnings.map((w, i) => (
        <li key={i} className="text-xs text-yellow-300 flex items-start gap-1">
          <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span>{w}</span>
        </li>
      ))}
    </ul>
  </div>
);

const StatBox: React.FC<{ label: string; value: string | number }> = ({
  label,
  value,
}) => (
  <div className="bg-gray-800 rounded p-2 text-center">
    <div className="text-lg font-semibold text-gray-100">{value}</div>
    <div className="text-xs text-gray-500">{label}</div>
  </div>
);

export default ImportDialog;
