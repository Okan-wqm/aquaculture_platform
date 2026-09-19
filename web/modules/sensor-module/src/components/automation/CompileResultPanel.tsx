/**
 * Compile / Validate Result Panel
 *
 * Shows ST validation results (errors, warnings) from the backend.
 */

import React from 'react';
import { AlertCircle, AlertTriangle, Info, CheckCircle } from 'lucide-react';
import { Spinner } from '@aquaculture/shared-ui';

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
  error: <AlertCircle className="h-4 w-4 text-error-500 flex-shrink-0" />,
  warning: <AlertTriangle className="h-4 w-4 text-warning-500 flex-shrink-0" />,
  info: <Info className="h-4 w-4 text-info-500 flex-shrink-0" />,
};

const severityBg = {
  error: 'bg-error-50 dark:bg-error-900/20 border-error-200 dark:border-error-800',
  warning: 'bg-warning-50 dark:bg-warning-900/20 border-warning-200 dark:border-warning-800',
  info: 'bg-info-50 dark:bg-info-900/20 border-info-200 dark:border-info-800',
};

const CompileResultPanel: React.FC<CompileResultPanelProps> = ({
  result,
  isValidating,
  onDiagnosticClick,
}) => {
  if (isValidating) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
        <Spinner size="sm" />
        <span className="text-sm text-gray-600 dark:text-gray-400">Validating ST code...</span>
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
      <div
        className={`flex items-center gap-2 px-4 py-2 rounded-lg border ${
          result.valid
            ? 'bg-success-50 dark:bg-success-900/20 border-success-200 dark:border-success-800'
            : 'bg-error-50 dark:bg-error-900/20 border-error-200 dark:border-error-800'
        }`}
      >
        {result.valid ? (
          <CheckCircle className="h-4 w-4 text-success-500" />
        ) : (
          <AlertCircle className="h-4 w-4 text-error-500" />
        )}
        <span
          className={`text-sm font-medium ${result.valid ? 'text-success-700 dark:text-success-300' : 'text-error-700 dark:text-error-300'}`}
        >
          {result.valid ? 'Validation successful' : 'Validation failed'}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400 ml-auto">
          {result.errors.length} errors, {result.warnings.length} warnings
          {result.parsedSymbols !== undefined && `, ${result.parsedSymbols} symbols`}
        </span>
      </div>

      {/* Diagnostics List */}
      {allDiagnostics.length > 0 && (
        <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
          {allDiagnostics.map((diag, idx) => (
            <button
              key={idx}
              onClick={() => onDiagnosticClick?.(diag.line, diag.column)}
              className={`w-full flex items-start gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${
                idx === 0 ? '' : ''
              }`}
            >
              {severityIcon[diag.severity]}
              <span className="text-gray-500 dark:text-gray-400 font-mono text-xs min-w-[4rem]">
                {diag.line}:{diag.column}
              </span>
              <span className="text-gray-700 dark:text-gray-300 flex-1">{diag.message}</span>
              {diag.code && (
                <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                  {diag.code}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default CompileResultPanel;
