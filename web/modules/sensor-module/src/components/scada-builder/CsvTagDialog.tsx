/**
 * CsvTagDialog - CSV Import/Export for SCADA widget tag bindings
 *
 * Export tab: generates CSV from current screen's widgets that have tag bindings.
 * Import tab: parses a CSV file and applies tag bindings to matching widgets.
 */

import React, { useState, useCallback, useRef, useMemo } from 'react';
import { Modal, DataTable, type DataTableColumn, Button } from '@aquaculture/shared-ui';
import { Download, Upload, FileSpreadsheet, AlertCircle, CheckCircle } from 'lucide-react';
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

  type TagExportRow = (typeof previewExportRows)[number];
  const tagExportRowColumns: DataTableColumn<TagExportRow>[] = [
    {
      key: 'widgetId',
      header: 'Widget ID',
      render: (_value, row) => row.widgetId,
    },
    {
      key: 'type',
      header: 'Type',
      render: (_value, row) => row.widgetType,
    },
    {
      key: 'tagName',
      header: 'Tag Name',
      render: (_value, row) => row.tagName,
    },
    {
      key: 'label',
      header: 'Label',
      render: (_value, row) => row.label,
    }
  ];

  // The CSV's first row names the columns; the rest are string cells by position.
  const importPreviewColumns: DataTableColumn<string[]>[] = (importPreviewRows[0] ?? []).map((col, idx) => ({
    key: `col-${idx}`,
    header: col,
    render: (_value, row) => (
      <span className="block max-w-[160px] truncate font-mono text-xs text-gray-700 dark:text-gray-300">{row[idx]}</span>
    ),
  }));

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      size="lg"
      className="max-h-[85vh] overflow-hidden flex flex-col"
      bodyClassName="flex-1 min-h-0 flex flex-col"
      title={
        <span className="flex items-center gap-2">
          <FileSpreadsheet className="w-5 h-5 text-cyan-600" />
          CSV Tag Import / Export
        </span>
      }
    >

        {/* Tab Bar */}
        <div className="flex border-b border-gray-200 dark:border-gray-700" role="tablist" aria-label="CSV operations">
          <button
            role="tab"
            aria-selected={tab === 'export'}
            aria-controls="csv-tab-export"
            id="csv-tab-btn-export"
            onClick={() => handleTabChange('export')}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === 'export'
                ? 'border-cyan-600 text-cyan-700'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100'
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
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100'
            }`}
          >
            <Upload className="w-4 h-4" />
            Import
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Screen info */}
          <div className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-100 dark:border-gray-700">
            <p className="text-sm text-gray-500 dark:text-gray-400">Active Screen</p>
            <p className="font-medium text-gray-900 dark:text-gray-100">
              {activeScreen?.name ?? 'No screen selected'}
            </p>
          </div>

          {/* ---- EXPORT TAB ---- */}
          {tab === 'export' && (
            <div role="tabpanel" id="csv-tab-export" aria-labelledby="csv-tab-btn-export">
              {exportRows.length === 0 ? (
                <div className="p-4 bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 rounded-lg text-sm text-center">
                  No widgets with tag bindings found on this screen.
                </div>
              ) : (
                <>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {exportRows.length} widget(s) with tag bindings.
                    {exportRows.length > 10 && ' Showing first 10 rows.'}
                  </p>
                  <DataTable<TagExportRow>
                    data={previewExportRows}
                    columns={tagExportRowColumns}
                    keyExtractor={(row) => row.widgetId}
                    emptyMessage="No rows"
                    searchable={false}
                    sortable={false}
                    stickyHeader={false}
                    compact
                  />
                </>
              )}
            </div>
          )}

          {/* ---- IMPORT TAB ---- */}
          {tab === 'import' && (
            <div role="tabpanel" id="csv-tab-import" aria-labelledby="csv-tab-btn-import">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  Select CSV File
                </label>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleFileSelect}
                  className="block w-full text-sm text-gray-500 dark:text-gray-400 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-cyan-50 file:text-cyan-700 hover:file:bg-cyan-100 cursor-pointer"
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
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    Preview ({importData.length - 1} data row(s)).
                    {importData.length > 11 && ' Showing first 10.'}
                  </p>
                  <DataTable<string[]>
                    data={importPreviewRows.slice(1)}
                    columns={importPreviewColumns}
                    keyExtractor={(_row, index) => String(index)}
                    emptyMessage="No rows"
                    searchable={false}
                    sortable={false}
                    stickyHeader={false}
                    compact
                  />
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 rounded-b-xl">
          <Button variant="secondary" size="lg" className="flex-1" onClick={onClose}>Close</Button>

          {tab === 'export' && exportRows.length > 0 && (
            <Button variant="primary" size="lg" className="flex-1 justify-center" leftIcon={<Download className="w-4 h-4" />} onClick={handleExport}>Download CSV</Button>
          )}

          {tab === 'import' && importData.length >= 2 && (
            <Button variant="primary" size="lg" className="flex-1 justify-center" leftIcon={<Upload className="w-4 h-4" />} onClick={handleApplyImport}>Apply</Button>
          )}
        </div>
    </Modal>
  );
};

export default CsvTagDialog;
