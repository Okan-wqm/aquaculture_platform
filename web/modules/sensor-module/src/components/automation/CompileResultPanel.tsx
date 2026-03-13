/**
 * Compile / Validate Result Panel
 *
 * Shows ST validation results (errors, warnings) from the backend.
 */

import React from 'react';
import { AlertCircle, AlertTriangle, Info, CheckCircle, Loader2 } from 'lucide-react';

export interface ValidationDiagnostic {
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  code?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationDiagnostic[];
  warnings: ValidationDiagnostic[];
  infos: ValidationDiagnostic[];
  parsedSymbols?: number;
}

interface CompileResultPanelProps {
  result: ValidationResult | null;
  isValidating: boolean;
  onDiagnosticClick?: (line: number, column: number) => void;
}

const severityIcon = {
  error: <AlertCircle className="h-4 w-4 text-red-500 flex-shrink-0" />,
  warning: <AlertTriangle className="h-4 w-4 text-yellow-500 flex-shrink-0" />,
  info: <Info className="h-4 w-4 text-blue-500 flex-shrink-0" />,
};

const severityBg = {
  error: 'bg-red-50 border-red-200',
  warning: 'bg-yellow-50 border-yellow-200',
  info: 'bg-blue-50 border-blue-200',
};

const CompileResultPanel: React.FC<CompileResultPanelProps> = ({
  result,
  isValidating,
  onDiagnosticClick,
}) => {
  if (isValidating) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 bg-gray-50 rounded-lg border border-gray-200">
        <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
        <span className="text-sm text-gray-600">Validating ST code...</span>
      </div>
    );
  }

  if (!result) {
    return null;
  }

  const allDiagnostics: (ValidationDiagnostic & { severity: 'error' | 'warning' | 'info' })[] = [
    ...result.errors.map((d) => ({ ...d, severity: 'error' as const })),
    ...result.warnings.map((d) => ({ ...d, severity: 'warning' as const })),
    ...result.infos.map((d) => ({ ...d, severity: 'info' as const })),
  ].sort((a, b) => a.line - b.line || a.column - b.column);

  return (
    <div className="space-y-2">
      {/* Summary */}
      <div className={`flex items-center gap-2 px-4 py-2 rounded-lg border ${
        result.valid
          ? 'bg-green-50 border-green-200'
          : 'bg-red-50 border-red-200'
      }`}>
        {result.valid ? (
          <CheckCircle className="h-4 w-4 text-green-500" />
        ) : (
          <AlertCircle className="h-4 w-4 text-red-500" />
        )}
        <span className={`text-sm font-medium ${result.valid ? 'text-green-700' : 'text-red-700'}`}>
          {result.valid ? 'Validation successful' : 'Validation failed'}
        </span>
        <span className="text-xs text-gray-500 ml-auto">
          {result.errors.length} errors, {result.warnings.length} warnings
          {result.parsedSymbols !== undefined && `, ${result.parsedSymbols} symbols`}
        </span>
      </div>

      {/* Diagnostics List */}
      {allDiagnostics.length > 0 && (
        <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-100">
          {allDiagnostics.map((diag, idx) => (
            <button
              key={idx}
              onClick={() => onDiagnosticClick?.(diag.line, diag.column)}
              className={`w-full flex items-start gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 transition-colors ${
                idx === 0 ? '' : ''
              }`}
            >
              {severityIcon[diag.severity]}
              <span className="text-gray-400 font-mono text-xs min-w-[4rem]">
                {diag.line}:{diag.column}
              </span>
              <span className="text-gray-700 flex-1">{diag.message}</span>
              {diag.code && (
                <span className="text-xs text-gray-400 font-mono">{diag.code}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default CompileResultPanel;
