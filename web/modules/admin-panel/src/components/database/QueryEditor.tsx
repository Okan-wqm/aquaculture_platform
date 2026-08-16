/**
 * SQL Query Editor Component
 *
 * A simple SQL query editor for the database explorer with:
 * - Dark-themed editor area with line numbers
 * - Query history (localStorage-based)
 * - Schema context selector
 * - Results table with export/copy functionality
 * - Safety warnings (SELECT only)
 */

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Card, Button, Alert, Badge } from '@aquaculture/shared-ui';
import { databaseApi } from '../../services/adminApi';
import {
  createAdminDownloadFilename,
  downloadAdminOwnedBlob,
} from '../../services/browser-capabilities';

// ============================================================================
// Types
// ============================================================================

export interface QueryEditorProps {
  /** Default schema to use for queries */
  defaultSchema?: string;
  /** Callback when query returns results */
  onQueryResult?: (result: { rows: unknown[]; rowCount: number }) => void;
}

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  columns: string[];
  executionTimeMs: number;
}

interface QueryHistoryItem {
  query: string;
  timestamp: number;
  schema: string;
}

// ============================================================================
// Constants
// ============================================================================

const QUERY_HISTORY_KEY = 'admin_sql_query_history';
const MAX_HISTORY_ITEMS = 10;
const MIN_EDITOR_HEIGHT = 120;
const MAX_EDITOR_HEIGHT = 600;
const DEFAULT_EDITOR_HEIGHT = 200;

// ============================================================================
// API Functions
// ============================================================================

const fetchSchemas = async (): Promise<readonly string[]> => {
  const result = await databaseApi.getExplorerSchemas();
  return result.schemas;
};

// Fix: C13 -- backend ExecuteQueryDto expects { sql, params }, not { schema, query }
async function executeQuery(_schema: string, query: string) {
  return databaseApi.executeExplorerQuery(query);
}

// ============================================================================
// Utilities
// ============================================================================

const formatValue = (value: unknown): string => {
  if (value === null) return 'NULL';
  if (value === undefined) return '';
  if (typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    return JSON.stringify(value);
  }
  return String(value);
};

const formatExecutionTime = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

const getQueryHistory = (): QueryHistoryItem[] => {
  try {
    const stored = localStorage.getItem(QUERY_HISTORY_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
};

// Truncate query for history to avoid storing sensitive filter values in full
const truncateForHistory = (query: string): string => {
  const MAX_PREVIEW = 120;
  const trimmed = query.trim();
  if (trimmed.length <= MAX_PREVIEW) return trimmed;
  return trimmed.substring(0, MAX_PREVIEW) + '…';
};

const saveQueryToHistory = (query: string, schema: string): void => {
  try {
    const history = getQueryHistory();
    const trimmedQuery = query.trim();
    const preview = truncateForHistory(trimmedQuery);

    // Don't save empty queries or duplicates at the top
    if (!trimmedQuery) return;
    if (history.length > 0 && history[0].query === preview) return;

    const newItem: QueryHistoryItem = {
      query: preview,
      timestamp: Date.now(),
      schema,
    };

    const updatedHistory = [newItem, ...history.filter((h) => h.query !== preview)].slice(
      0,
      MAX_HISTORY_ITEMS,
    );

    localStorage.setItem(QUERY_HISTORY_KEY, JSON.stringify(updatedHistory));
  } catch {
    // Silently fail if localStorage is unavailable
  }
};

// Enforce SELECT-only queries client-side
const isSelectOnlyQuery = (query: string): boolean => {
  const normalized = query.trim().replace(/\s+/g, ' ').toLowerCase();
  // Reject any statement that starts with a DML/DDL keyword
  const forbiddenPrefixes = [
    'insert',
    'update',
    'delete',
    'drop',
    'truncate',
    'alter',
    'create',
    'grant',
    'revoke',
    'exec',
    'execute',
    'call',
  ];
  return !forbiddenPrefixes.some((kw) => normalized.startsWith(kw));
};

const exportToCSV = (columns: string[], rows: Record<string, unknown>[]): void => {
  // Fix: Review feedback -- formula injection koruması eklendi
  const escapeCsvValue = (value: string): string => {
    if (/^[=+\-@\t\r]/.test(value)) {
      return `"'${value.replace(/"/g, '""')}"`;
    }
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  };

  const header = columns.map(escapeCsvValue).join(',');
  const dataRows = rows.map((row) =>
    columns.map((col) => escapeCsvValue(formatValue(row[col]))).join(','),
  );

  const csvContent = [header, ...dataRows].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  downloadAdminOwnedBlob({
    blob,
    filename: createAdminDownloadFilename(
      `query_result_${new Date().toISOString().slice(0, 19).replace(/[:-]/g, '')}.csv`,
    ),
  });
};

const copyResultsToClipboard = async (
  columns: string[],
  rows: Record<string, unknown>[],
): Promise<boolean> => {
  try {
    const header = columns.join('\t');
    const dataRows = rows.map((row) => columns.map((col) => formatValue(row[col])).join('\t'));
    const content = [header, ...dataRows].join('\n');
    await navigator.clipboard.writeText(content);
    return true;
  } catch {
    return false;
  }
};

// ============================================================================
// Line Numbers Component
// ============================================================================

interface LineNumbersProps {
  lineCount: number;
  height: number;
}

const LineNumbers: React.FC<LineNumbersProps> = React.memo(({ lineCount, height }) => {
  const lines = useMemo(
    () => Array.from({ length: Math.max(lineCount, 1) }, (_, i) => i + 1),
    [lineCount],
  );

  return (
    <div
      className="absolute left-0 top-0 w-10 bg-gray-800 text-gray-500 text-right pr-2 pt-3 select-none overflow-hidden border-r border-gray-700"
      style={{ height: height, fontFamily: 'monospace', fontSize: '14px', lineHeight: '1.5' }}
    >
      {lines.map((num) => (
        <div key={num}>{num}</div>
      ))}
    </div>
  );
});

// ============================================================================
// Resize Handle Component
// ============================================================================

interface ResizeHandleProps {
  onResize: (delta: number) => void;
}

const ResizeHandle: React.FC<ResizeHandleProps> = ({ onResize }) => {
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientY - startY;
        onResize(delta);
      };

      const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [onResize],
  );

  return (
    <div
      className="h-2 bg-gray-700 cursor-ns-resize flex items-center justify-center hover:bg-gray-600 transition-colors"
      onMouseDown={handleMouseDown}
    >
      <div className="w-8 h-1 bg-gray-500 rounded" />
    </div>
  );
};

// ============================================================================
// Query History Dropdown Component
// ============================================================================

interface QueryHistoryDropdownProps {
  history: QueryHistoryItem[];
  onSelect: (query: string) => void;
  isOpen: boolean;
  onToggle: () => void;
}

const QueryHistoryDropdown: React.FC<QueryHistoryDropdownProps> = ({
  history,
  onSelect,
  isOpen,
  onToggle,
}) => {
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        if (isOpen) onToggle();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onToggle]);

  if (history.length === 0) {
    return (
      <Button variant="outline" size="sm" disabled>
        <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        History
      </Button>
    );
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <Button variant="outline" size="sm" onClick={onToggle}>
        <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        History ({history.length})
        <svg
          className={`w-4 h-4 ml-1 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </Button>

      {isOpen && (
        <div className="absolute z-50 mt-1 w-96 max-h-64 overflow-y-auto bg-white rounded-lg shadow-lg border border-gray-200">
          {history.map((item, index) => (
            <button
              key={item.timestamp}
              className="w-full text-left px-3 py-2 hover:bg-gray-100 border-b border-gray-100 last:border-b-0"
              onClick={() => {
                onSelect(item.query);
                onToggle();
              }}
            >
              <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                <span>
                  {new Date(item.timestamp).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <Badge variant="default">{item.schema}</Badge>
              </div>
              <code className="text-xs text-gray-700 font-mono block truncate">
                {item.query.length > 80 ? `${item.query.slice(0, 80)}...` : item.query}
              </code>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Results Table Component
// ============================================================================

interface ResultsTableProps {
  result: QueryResult;
  onExportCSV: () => void;
  onCopyToClipboard: () => void;
  copySuccess: boolean;
}

const ResultsTable: React.FC<ResultsTableProps> = ({
  result,
  onExportCSV,
  onCopyToClipboard,
  copySuccess,
}) => {
  return (
    <Card className="mt-4 overflow-hidden">
      {/* Results Header */}
      <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-gray-700">
            Results: <span className="text-blue-600">{result.rowCount.toLocaleString()}</span> rows
          </span>
          <Badge variant="info">{formatExecutionTime(result.executionTimeMs)}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onCopyToClipboard}>
            {copySuccess ? (
              <>
                <svg
                  className="w-4 h-4 mr-1 text-green-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                Copied!
              </>
            ) : (
              <>
                <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                  />
                </svg>
                Copy
              </>
            )}
          </Button>
          <Button variant="outline" size="sm" onClick={onExportCSV}>
            <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
            Export CSV
          </Button>
        </div>
      </div>

      {/* Results Table */}
      <div className="overflow-x-auto max-h-96">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              {result.columns.map((column) => (
                <th
                  key={column}
                  className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider bg-gray-50"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {result.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="hover:bg-gray-50">
                {result.columns.map((column) => (
                  <td
                    key={column}
                    className="px-4 py-2 text-sm text-gray-900 max-w-xs truncate"
                    title={formatValue(row[column])}
                  >
                    {row[column] === null ? (
                      <span className="text-gray-500 italic">NULL</span>
                    ) : typeof row[column] === 'object' ? (
                      <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">
                        {formatValue(row[column]).substring(0, 50)}
                        {formatValue(row[column]).length > 50 ? '...' : ''}
                      </code>
                    ) : (
                      formatValue(row[column])
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {result.rows.length === 0 && (
          <div className="flex items-center justify-center py-8 text-gray-500">
            Query returned no results
          </div>
        )}
      </div>
    </Card>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const QueryEditor: React.FC<QueryEditorProps> = ({
  defaultSchema = 'public',
  onQueryResult,
}) => {
  // State
  const [query, setQuery] = useState('');
  const [selectedSchema, setSelectedSchema] = useState(defaultSchema);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [isExecuting, setIsExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [editorHeight, setEditorHeight] = useState(DEFAULT_EDITOR_HEIGHT);
  const [queryHistory, setQueryHistory] = useState<QueryHistoryItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const baseHeightRef = useRef(DEFAULT_EDITOR_HEIGHT);

  // Load schemas on mount
  useEffect(() => {
    fetchSchemas()
      .then((fetchedSchemas) => {
        setSchemas([...fetchedSchemas]);
        if (fetchedSchemas.length > 0 && !fetchedSchemas.includes(selectedSchema)) {
          setSelectedSchema(fetchedSchemas[0]);
        }
      })
      .catch(() => {
        // Use default public schema if fetch fails
        setSchemas(['public']);
      });
  }, []);

  // Load query history on mount
  useEffect(() => {
    setQueryHistory(getQueryHistory());
  }, []);

  // Calculate line count for line numbers
  const lineCount = useMemo(() => {
    return query.split('\n').length;
  }, [query]);

  // Execute query
  const handleExecute = useCallback(async () => {
    if (isExecuting) return;

    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setError('Please enter a SQL query');
      return;
    }

    if (!isSelectOnlyQuery(trimmedQuery)) {
      setError(
        'Only SELECT queries are allowed. INSERT, UPDATE, DELETE, DROP, and other write operations are not permitted.',
      );
      return;
    }

    setIsExecuting(true);
    setError(null);
    setResult(null);

    const startTime = performance.now();

    try {
      const response = await executeQuery(selectedSchema, trimmedQuery);
      const executionTimeMs = Math.round(performance.now() - startTime);
      const rows = response.rows.map((row) => ({ ...row }));
      const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];

      const queryResult: QueryResult = {
        rows,
        rowCount: response.rowCount,
        columns,
        executionTimeMs,
      };

      setResult(queryResult);

      // Save to history
      saveQueryToHistory(trimmedQuery, selectedSchema);
      setQueryHistory(getQueryHistory());

      // Call parent callback
      if (onQueryResult) {
        onQueryResult({ rows: [...response.rows], rowCount: response.rowCount });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Query execution failed');
    } finally {
      setIsExecuting(false);
    }
  }, [query, selectedSchema, onQueryResult]);

  // Handle tab key
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Tab key - insert 2 spaces
      if (e.key === 'Tab') {
        e.preventDefault();
        const target = e.target as HTMLTextAreaElement;
        const start = target.selectionStart;
        const end = target.selectionEnd;

        const newValue = query.substring(0, start) + '  ' + query.substring(end);
        setQuery(newValue);

        // Set cursor position after the inserted spaces
        requestAnimationFrame(() => {
          target.selectionStart = target.selectionEnd = start + 2;
        });
      }

      // Ctrl+Enter - execute query
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleExecute();
      }
    },
    [query, handleExecute],
  );

  // Clear editor
  const handleClear = useCallback(() => {
    setQuery('');
    setError(null);
    setResult(null);
    textareaRef.current?.focus();
  }, []);

  // Handle resize
  const handleResize = useCallback((delta: number) => {
    setEditorHeight((prev) => {
      const newHeight = baseHeightRef.current + delta;
      return Math.max(MIN_EDITOR_HEIGHT, Math.min(MAX_EDITOR_HEIGHT, newHeight));
    });
  }, []);

  // Update base height when resize ends — use a ref to editorHeight to avoid re-registering on each change (PERF-007)
  const editorHeightRef = useRef(editorHeight);
  useEffect(() => {
    editorHeightRef.current = editorHeight;
  }, [editorHeight]);

  useEffect(() => {
    const handleMouseUp = () => {
      baseHeightRef.current = editorHeightRef.current;
    };
    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, []);

  // Handle history selection
  const handleHistorySelect = useCallback((selectedQuery: string) => {
    setQuery(selectedQuery);
    textareaRef.current?.focus();
  }, []);

  // Handle export
  const handleExportCSV = useCallback(() => {
    if (result) {
      exportToCSV(result.columns, result.rows);
    }
  }, [result]);

  // Handle copy
  const handleCopyToClipboard = useCallback(async () => {
    if (result) {
      const success = await copyResultsToClipboard(result.columns, result.rows);
      if (success) {
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 2000);
      }
    }
  }, [result]);

  return (
    <div className="space-y-4">
      {/* Safety Warning */}
      <Alert type="warning">
        <div className="flex items-center gap-2">
          <svg
            className="w-5 h-5 flex-shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <span>
            <strong>Read-only mode:</strong> Only SELECT queries are allowed. Data modification
            queries (INSERT, UPDATE, DELETE, DROP, etc.) will be rejected.
          </span>
        </div>
      </Alert>

      {/* Editor Card */}
      <Card className="overflow-hidden">
        {/* Editor Toolbar */}
        <div className="px-4 py-3 bg-gray-100 border-b flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <label htmlFor="schema-select" className="text-sm font-medium text-gray-700">
                Schema:
              </label>
              <select
                id="schema-select"
                className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                value={selectedSchema}
                onChange={(e) => setSelectedSchema(e.target.value)}
              >
                {schemas.map((schema) => (
                  <option key={schema} value={schema}>
                    {schema}
                  </option>
                ))}
              </select>
            </div>

            <QueryHistoryDropdown
              history={queryHistory}
              onSelect={handleHistorySelect}
              isOpen={historyOpen}
              onToggle={() => setHistoryOpen(!historyOpen)}
            />
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleClear} disabled={isExecuting}>
              <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
              Clear
            </Button>
            <Button onClick={handleExecute} loading={isExecuting} disabled={!query.trim()}>
              <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              Execute
              <span className="ml-1 text-xs opacity-70">(Ctrl+Enter)</span>
            </Button>
          </div>
        </div>

        {/* Editor Area */}
        <div className="relative bg-gray-900" style={{ height: editorHeight }}>
          <LineNumbers lineCount={lineCount} height={editorHeight} />
          <textarea
            ref={textareaRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter your SQL query here...

Example:
SELECT * FROM users LIMIT 10;"
            className="absolute left-10 top-0 right-0 bottom-0 w-[calc(100%-40px)] h-full p-3 bg-gray-900 text-gray-100 font-mono text-sm resize-none focus:outline-hidden focus:ring-0 border-0"
            style={{
              lineHeight: '1.5',
              tabSize: 2,
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
          />
        </div>

        {/* Resize Handle */}
        <ResizeHandle onResize={handleResize} />
      </Card>

      {/* Error Message */}
      {error && (
        <Alert type="error" dismissible onDismiss={() => setError(null)}>
          <div className="font-medium">Query Error</div>
          <div className="mt-1 text-sm font-mono">{error}</div>
        </Alert>
      )}

      {/* Results */}
      {result && (
        <ResultsTable
          result={result}
          onExportCSV={handleExportCSV}
          onCopyToClipboard={handleCopyToClipboard}
          copySuccess={copySuccess}
        />
      )}
    </div>
  );
};

export default QueryEditor;
