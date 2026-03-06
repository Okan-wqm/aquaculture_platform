/**
 * ST Diagnostics Provider
 *
 * Sends code to backend via WebSocket for analysis, receives Diagnostic[],
 * and sets Monaco markers. Debounced: 300ms after last keystroke.
 */

import type * as Monaco from 'monaco-editor';
import { stWebSocketService } from '../../../services/st-websocket.service';
import type { STDiagnostic } from '../../../types/st-editor.types';
import { ST_DEBOUNCE_MS } from '../../../types/st-editor.types';

function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const SEVERITY_MAP: Record<string, number> = {
  error: 8,    // MarkerSeverity.Error
  warning: 4,  // MarkerSeverity.Warning
  info: 2,     // MarkerSeverity.Info
  hint: 1,     // MarkerSeverity.Hint
};

const MARKER_OWNER = 'st-language-service';

/**
 * Manages diagnostic analysis via WebSocket.
 * Call `start()` to begin watching a model, `dispose()` to stop.
 */
export class STDiagnosticsManager {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private disposables: (() => void)[] = [];
  private currentModel: Monaco.editor.ITextModel | null = null;
  private monacoInstance: typeof Monaco | null = null;
  private isAnalyzing = false;
  private onDiagnosticsChange?: (diagnostics: STDiagnostic[]) => void;
  private onAnalyzingChange?: (analyzing: boolean) => void;

  constructor(options?: {
    onDiagnosticsChange?: (diagnostics: STDiagnostic[]) => void;
    onAnalyzingChange?: (analyzing: boolean) => void;
  }) {
    this.onDiagnosticsChange = options?.onDiagnosticsChange;
    this.onAnalyzingChange = options?.onAnalyzingChange;
  }

  /**
   * Start watching a Monaco model for changes and trigger analysis.
   */
  start(monaco: typeof Monaco, model: Monaco.editor.ITextModel): void {
    this.dispose();
    this.monacoInstance = monaco;
    this.currentModel = model;

    // Listen for content changes
    const changeDisposable = model.onDidChangeContent(() => {
      this.scheduleAnalysis();
    });
    this.disposables.push(() => changeDisposable.dispose());

    // Run initial analysis
    this.scheduleAnalysis();
  }

  /**
   * Manually trigger analysis (e.g., on save or compile).
   */
  triggerAnalysis(): void {
    this.scheduleAnalysis(0);
  }

  /**
   * Stop watching and clear markers.
   */
  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    for (const dispose of this.disposables) {
      dispose();
    }
    this.disposables = [];

    // Clear existing markers
    if (this.monacoInstance && this.currentModel) {
      this.monacoInstance.editor.setModelMarkers(this.currentModel, MARKER_OWNER, []);
    }

    this.currentModel = null;
    this.monacoInstance = null;
  }

  private scheduleAnalysis(delay: number = ST_DEBOUNCE_MS): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.runAnalysis();
    }, delay);
  }

  private async runAnalysis(): Promise<void> {
    const model = this.currentModel;
    const monaco = this.monacoInstance;
    if (!model || !monaco || model.isDisposed()) return;

    if (!stWebSocketService.isConnected()) {
      return;
    }

    this.isAnalyzing = true;
    this.onAnalyzingChange?.(true);

    try {
      const code = model.getValue();
      const response = await stWebSocketService.request({
        type: 'analyze',
        requestId: generateRequestId(),
        code,
      });

      // Model may have been disposed/changed during async request
      if (!this.currentModel || this.currentModel !== model || model.isDisposed()) return;

      const diagnostics = (response.data as STDiagnostic[]) ?? [];

      // Convert to Monaco markers
      const markers: Monaco.editor.IMarkerData[] = diagnostics.map((d) => ({
        startLineNumber: d.range.startLine + 1, // 0-based to 1-based
        startColumn: d.range.startCol + 1,
        endLineNumber: d.range.endLine + 1,
        endColumn: d.range.endCol + 1,
        message: d.message,
        severity: SEVERITY_MAP[d.severity] ?? 8,
        source: d.source,
        code: d.code,
      }));

      monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
      this.onDiagnosticsChange?.(diagnostics);
    } catch (err) {
      // Analysis failed (timeout, disconnect, etc.) - clear markers
      if (model && !model.isDisposed() && monaco) {
        monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
      }
    } finally {
      this.isAnalyzing = false;
      this.onAnalyzingChange?.(false);
    }
  }
}
