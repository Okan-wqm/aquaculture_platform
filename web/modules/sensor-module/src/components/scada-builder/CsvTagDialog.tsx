/**
 * CsvTagDialog - CSV Import/Export for SCADA widget tag bindings
 *
 * Export tab: generates CSV from current screen's widgets that have tag bindings.
 * Import tab: parses a CSV file and applies tag bindings to matching widgets.
 */

import React, { useState, useCallback, useRef, useMemo } from 'react';
import { Download, Upload, X, FileSpreadsheet, AlertCircle, CheckCircle } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useScadaPackageStore } from '../../store/scada';

interface CsvRow {
  widgetId: string;
  widgetType: string;
  tagName: string;
  label: string;
}

interface CsvTagDialogProps {
  open: boolean;
  onClose: () => void;
}

const CSV_HEADER = 'widgetId,widgetType,tagName,label';

/** Escape a field for CSV output (wrap in quotes if it contains comma, quote, or newline). */
function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Parse a single CSV line respecting quoted fields. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

export const CsvTagDialog: React.FC<CsvTagDialogProps> = ({ open, onClose }) => {
  const [tab, setTab] = useState<'export' | 'import'>('export');
  const fileRef = useRef<HTMLInputElement>(null);
  const [importData, setImportData] = useState<string[][]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const [applySuccess, setApplySuccess] = useState<number | null>(null);

  const { screens, activeScreenId, updateWidget } = useScadaPackageStore(
    useShallow((s) => ({
      screens: s.screens,
      activeScreenId: s.activeScreenId,
      updateWidget: s.updateWidget,
    })),
  );

  const activeScreen = screens.find((s) => s.id === activeScreenId);

  // Build export rows from current screen widgets with tag bindings
  const exportRows: CsvRow[] = useMemo(() => {
    if (!activeScreen) return [];
    return activeScreen.widgets
      .filter((w) => {
        const tag = (w.config.tagName ?? w.config.tag ?? '') as string;
        return tag.length > 0;
      })
      .map((w) => ({
        widgetId: w.id,
        widgetType: w.widgetType,
        tagName: (w.config.tagName ?? w.config.tag ?? '') as string,
        label: (w.config.label ?? '') as string,
      }));
  }, [activeScreen]);

  // Generate CSV string
  const generateCsv = useCallback((): string => {
    const rows = exportRows.map(
      (r) =>
        `${escapeCsvField(r.widgetId)},${escapeCsvField(r.widgetType)},${escapeCsvField(r.tagName)},${escapeCsvField(r.label)}`,
    );
    return [CSV_HEADER, ...rows].join('\n');
  }, [exportRows]);

  // Download CSV
  const handleExport = useCallback(() => {
    const csv = generateCsv();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeScreen?.name ?? 'scada'}-tags.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [generateCsv, activeScreen]);

  // Parse uploaded CSV file
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    setApplySuccess(null);

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = reader.result as string;
        const lines = text
          .trim()
          .split(/\r?\n/)
          .map((line) => parseCsvLine(line));

        if (lines.length < 2) {
          setImportError('CSV must have a header row and at least one data row.');
          return;
        }

        const header = lines[0];
        if (!header.includes('widgetId') || !header.includes('tagName')) {
          setImportError('CSV must have "widgetId" and "tagName" columns.');
          return;
        }

        setImportData(lines);
      } catch {
        setImportError('Failed to parse CSV file.');
      }
    };
    reader.onerror = () => {
      setImportError('Failed to read file.');
    };
    reader.readAsText(file);

    // Reset file input so the same file can be re-selected
    if (fileRef.current) fileRef.current.value = '';
  }, []);

  // Apply imported tag bindings
  const handleApplyImport = useCallback(() => {
    if (!activeScreen || !activeScreenId || importData.length < 2) return;

    const header = importData[0];
    const idIdx = header.indexOf('widgetId');
    const tagIdx = header.indexOf('tagName');
    const labelIdx = header.indexOf('label');

    if (idIdx === -1 || tagIdx === -1) {
      setImportError('CSV must have "widgetId" and "tagName" columns.');
      return;
    }

    const missingIds: string[] = [];
    let applied = 0;

    for (let i = 1; i < importData.length; i++) {
      const row = importData[i];
      const widgetId = row[idIdx];
      const tagName = row[tagIdx];

      if (!widgetId || !tagName) continue;

      const widget = activeScreen.widgets.find((w) => w.id === widgetId);
      if (!widget) {
        missingIds.push(widgetId);
        continue;
      }

      const updates: Record<string, unknown> = { tagName };
      if (labelIdx !== -1 && row[labelIdx]) {
        updates.label = row[labelIdx];
      }

      updateWidget(activeScreenId, widgetId, {
        config: { ...widget.config, ...updates },
      });
      applied++;
    }

    if (missingIds.length > 0 && applied === 0) {
      setImportError(
        `None of the widget IDs matched. Missing: ${missingIds.slice(0, 5).join(', ')}${missingIds.length > 5 ? '...' : ''}`,
      );
      return;
    }

    if (missingIds.length > 0) {
      setImportError(
        `Applied ${applied} binding(s). ${missingIds.length} widget ID(s) not found: ${missingIds.slice(0, 3).join(', ')}${missingIds.length > 3 ? '...' : ''}`,
      );
    }

    setApplySuccess(applied);
    setImportData([]);

    if (applied > 0 && missingIds.length === 0) {
      setTimeout(() => onClose(), 1200);
    }
  }, [activeScreen, activeScreenId, importData, updateWidget, onClose]);

  // Reset state when switching tabs
  const handleTabChange = useCallback(
    (newTab: 'export' | 'import') => {
      setTab(newTab);
      setImportData([]);
      setImportError(null);
      setApplySuccess(null);
    },
    [],
  );

  if (!open) return null;

  const previewExportRows = exportRows.slice(0, 10);
  const importPreviewRows = importData.length > 1 ? importData.slice(0, 11) : []; // header + 10 rows max

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="csv-dialog-title"
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[85vh] overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h3 id="csv-dialog-title" className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-cyan-600" />
            CSV Tag Import / Export
          </h3>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
            aria-label="Close"
            title="Close"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Tab Bar */}
        <div className="flex border-b border-gray-200" role="tablist" aria-label="CSV operations">
          <button
            role="tab"
            aria-selected={tab === 'export'}
            aria-controls="csv-tab-export"
            id="csv-tab-btn-export"
            onClick={() => handleTabChange('export')}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === 'export'
                ? 'border-cyan-600 text-cyan-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <Download className="w-4 h-4" />
            Export
          </button>
          <button
            role="tab"
            aria-selected={tab === 'import'}
            aria-controls="csv-tab-import"
            id="csv-tab-btn-import"
            onClick={() => handleTabChange('import')}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === 'import'
                ? 'border-cyan-600 text-cyan-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <Upload className="w-4 h-4" />
            Import
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Screen info */}
          <div className="p-3 bg-gray-50 rounded-lg border border-gray-100">
            <p className="text-sm text-gray-500">Active Screen</p>
            <p className="font-medium text-gray-900">
              {activeScreen?.name ?? 'No screen selected'}
            </p>
          </div>

          {/* ---- EXPORT TAB ---- */}
          {tab === 'export' && (
            <div role="tabpanel" id="csv-tab-export" aria-labelledby="csv-tab-btn-export">
              {exportRows.length === 0 ? (
                <div className="p-4 bg-gray-50 text-gray-500 rounded-lg text-sm text-center">
                  No widgets with tag bindings found on this screen.
                </div>
              ) : (
                <>
                  <p className="text-sm text-gray-600">
                    {exportRows.length} widget(s) with tag bindings.
                    {exportRows.length > 10 && ' Showing first 10 rows.'}
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50 text-left text-gray-600">
                          <th className="px-3 py-2 font-medium">Widget ID</th>
                          <th className="px-3 py-2 font-medium">Type</th>
                          <th className="px-3 py-2 font-medium">Tag Name</th>
                          <th className="px-3 py-2 font-medium">Label</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {previewExportRows.map((row) => (
                          <tr key={row.widgetId} className="text-gray-700">
                            <td className="px-3 py-2 font-mono text-xs truncate max-w-[160px]">
                              {row.widgetId}
                            </td>
                            <td className="px-3 py-2">{row.widgetType}</td>
                            <td className="px-3 py-2 font-mono text-xs">{row.tagName}</td>
                            <td className="px-3 py-2">{row.label}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ---- IMPORT TAB ---- */}
          {tab === 'import' && (
            <div role="tabpanel" id="csv-tab-import" aria-labelledby="csv-tab-btn-import">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Select CSV File
                </label>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleFileSelect}
                  className="block w-full text-sm text-gray-500 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-cyan-50 file:text-cyan-700 hover:file:bg-cyan-100 cursor-pointer"
                />
              </div>

              {/* Error */}
              {importError && (
                <div className="p-3 rounded-lg flex items-start gap-2 bg-red-50 text-red-700 border border-red-200">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span className="text-sm">{importError}</span>
                </div>
              )}

              {/* Success */}
              {applySuccess !== null && (
                <div className="p-3 rounded-lg flex items-center gap-2 bg-green-50 text-green-700 border border-green-200">
                  <CheckCircle className="w-4 h-4 flex-shrink-0" />
                  <span className="text-sm font-medium">
                    Applied {applySuccess} tag binding(s) successfully.
                  </span>
                </div>
              )}

              {/* Import preview table */}
              {importPreviewRows.length > 0 && (
                <>
                  <p className="text-sm text-gray-600">
                    Preview ({importData.length - 1} data row(s)).
                    {importData.length > 11 && ' Showing first 10.'}
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50 text-left text-gray-600">
                          {importPreviewRows[0].map((col, idx) => (
                            <th key={idx} className="px-3 py-2 font-medium">
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {importPreviewRows.slice(1).map((row, rowIdx) => (
                          <tr key={rowIdx} className="text-gray-700">
                            {row.map((cell, cellIdx) => (
                              <td
                                key={cellIdx}
                                className="px-3 py-2 truncate max-w-[160px] font-mono text-xs"
                              >
                                {cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-4 border-t border-gray-200 bg-gray-50 rounded-b-xl">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 font-medium transition-colors"
          >
            Close
          </button>

          {tab === 'export' && exportRows.length > 0 && (
            <button
              onClick={handleExport}
              className="flex-1 px-4 py-2.5 text-white bg-cyan-600 rounded-lg hover:bg-cyan-700 font-medium transition-colors flex items-center justify-center gap-2"
            >
              <Download className="w-4 h-4" />
              Download CSV
            </button>
          )}

          {tab === 'import' && importData.length >= 2 && (
            <button
              onClick={handleApplyImport}
              className="flex-1 px-4 py-2.5 text-white bg-cyan-600 rounded-lg hover:bg-cyan-700 font-medium transition-colors flex items-center justify-center gap-2"
            >
              <Upload className="w-4 h-4" />
              Apply
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default CsvTagDialog;
