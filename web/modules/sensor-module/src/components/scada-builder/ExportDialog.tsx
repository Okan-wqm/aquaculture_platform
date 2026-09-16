/**
 * Export the current SCADA view as PNG or PDF.
 *
 * SECURITY ARCHITECTURE (replaces the previous in-page foreignObject path):
 *
 *  1. The ReactFlow viewport DOM is cloned in-page and the ALLOWLISTED
 *     computed styles are inlined into the clone (exportUtils). url()
 *     resources are dropped unless they are data: or same-origin.
 *  2. The serialized SVG is sent via postMessage into a hidden
 *     `<iframe sandbox="allow-scripts">` — deliberately WITHOUT
 *     allow-same-origin, so the iframe runs on an opaque origin, inherits
 *     the page CSP, and can never touch the app's DOM/storage/cookies.
 *     All rasterization (Image → canvas → dataURL) happens INSIDE that
 *     iframe; only the final data URL crosses back out via postMessage.
 *  3. CONVENTION: the serialized export SVG is NEVER assigned to
 *     innerHTML / dangerouslySetInnerHTML anywhere. It is untrusted
 *     markup and is only ever fed to an <img src> inside the sandbox.
 *
 * PDF: the raster is embedded as a JPEG XObject with `/Filter /DCTDecode`
 * and a page sized in POINTS scaled to fit (never raw pixels).
 *
 * PNG: the iframe returns image/png data.
 *
 * Output resolution is hard-capped at 40 megapixels (exportUtils.capResolution).
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { X, Download, Image as ImageIcon, FileText, Loader2 } from 'lucide-react';

import {
  capResolution,
  inlineComputedStylesIntoClone,
  buildPdfFromJpeg,
} from './exportUtils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExportFormat = 'png' | 'pdf';
type ExportResolution = 1 | 2 | 3;

interface ExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** The CSS selector or ref to the ReactFlow viewport container. */
  canvasSelector?: string;
}

// ---------------------------------------------------------------------------
// Sandboxed-iframe rasterizer
// ---------------------------------------------------------------------------

/**
 * Minimal document running inside the sandboxed iframe. It receives the
 * serialized SVG over postMessage, rasterizes it on its OWN canvas (opaque
 * origin, inherits the page CSP), and posts the data URL back.
 */
const SANDBOX_DOC = `<!DOCTYPE html><html><body><script>
(function () {
  var CANVAS_LIMIT = 40 * 1000 * 1000; // 40MP hard cap, mirrored from exportUtils
  function reply(msg) { parent.postMessage(msg, '*'); }
  window.addEventListener('message', function (ev) {
    var d = ev.data || {};
    if (d.type !== 'scada-export-raster') return;
    try {
      var blob = new Blob([d.svg], { type: 'image/svg+xml;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var w = d.width, h = d.height;
        if (w * h > CANVAS_LIMIT) {
          var s = Math.sqrt(CANVAS_LIMIT / (w * h));
          w = Math.floor(w * s); h = Math.floor(h * s);
        }
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext('2d');
        if (!ctx) { reply({ type: 'scada-export-result', error: 'Canvas 2D context unavailable' }); return; }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        var dataUrl;
        try {
          dataUrl = canvas.toDataURL(d.mime, d.quality || undefined);
        } catch (secErr) {
          reply({ type: 'scada-export-result', error: 'Canvas is tainted (SecurityError): the export contains a cross-origin resource that CSP did not permit.' });
          return;
        }
        reply({ type: 'scada-export-result', dataUrl: dataUrl, width: w, height: h });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reply({ type: 'scada-export-result', error: 'SVG rasterization failed (image load blocked — check CSP img-src)' });
      };
      img.src = url;
    } catch (err) {
      reply({ type: 'scada-export-result', error: (err && err.message) || 'Sandboxed rasterization failed' });
    }
  });
})();
</script></body></html>`;

/**
 * Serialize the canvas and rasterize it inside the sandboxed iframe.
 * SECURITY: the returned markup is only used as an image source inside the
 * sandbox — never as HTML anywhere.
 */
async function captureViewportInSandbox(
  selector: string,
  scale: ExportResolution,
  mime: 'image/png' | 'image/jpeg',
  quality?: number,
  timeoutMs = 15000,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const container = (document.querySelector(selector) ?? document.querySelector('.react-flow__viewport'))
    ?.closest('.react-flow') as HTMLElement | null;
  if (!container) {
    throw new Error('Could not find ReactFlow viewport element');
  }

  // Clone + inline allowlisted computed styles (drops foreign url() values)
  const clone = container.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.react-flow__controls, .react-flow__minimap, [data-export-exclude]')
    .forEach((el) => el.remove());
  inlineComputedStylesIntoClone(container, clone, [window.location.origin]);

  const rect = container.getBoundingClientRect();
  const capped = capResolution(
    Math.max(1, Math.round(rect.width * scale)),
    Math.max(1, Math.round(rect.height * scale)),
  );

  const svgStr = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${capped.width}" height="${capped.height}">`,
    `<foreignObject width="100%" height="100%">`,
    `<div xmlns="http://www.w3.org/1999/xhtml" style="transform: scale(${capped.scale * scale}); transform-origin: top left;">`,
    new XMLSerializer().serializeToString(clone),
    `</div></foreignObject></svg>`,
  ].join('');

  // Sandboxed rasterization iframe (allow-scripts only — opaque origin)
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '1px';
  iframe.style.height = '1px';
  iframe.style.border = '0';
  iframe.style.opacity = '0';
  iframe.srcdoc = SANDBOX_DOC;
  document.body.appendChild(iframe);

  try {
    return await new Promise<{ dataUrl: string; width: number; height: number }>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Export timed out while rasterizing in the sandboxed iframe'));
      }, timeoutMs);

      const onMessage = (ev: MessageEvent) => {
        if (ev.source !== iframe.contentWindow) return;
        const data = ev.data as
          | { type: 'scada-export-result'; dataUrl?: string; width?: number; height?: number; error?: string }
          | undefined;
        if (!data || data.type !== 'scada-export-result') return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        if (data.error || !data.dataUrl) {
          reject(new Error(data.error ?? 'Sandboxed rasterization failed'));
        } else {
          resolve({
            dataUrl: data.dataUrl,
            width: data.width ?? capped.width,
            height: data.height ?? capped.height,
          });
        }
      };
      window.addEventListener('message', onMessage);

      const trySend = (attempts: number) => {
        const win = iframe.contentWindow;
        if (!win) {
          if (attempts > 0) {
            window.setTimeout(() => trySend(attempts - 1), 50);
          } else {
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            reject(new Error('Sandboxed iframe failed to initialize'));
          }
          return;
        }
        win.postMessage(
          { type: 'scada-export-raster', svg: svgStr, width: capped.width, height: capped.height, mime, quality },
          '*',
        );
      };
      iframe.addEventListener('load', () => trySend(3), { once: true });
    });
  } finally {
    iframe.remove();
  }
}

/** Decode a data URL to raw bytes. */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ExportDialog: React.FC<ExportDialogProps> = ({
  isOpen,
  onClose,
  canvasSelector = '.react-flow__viewport',
}) => {
  const [format, setFormat] = useState<ExportFormat>('png');
  const [resolution, setResolution] = useState<ExportResolution>(2);
  const [filename, setFilename] = useState('scada-export');
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Escape closes the dialog (a11y)
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    setError(null);

    try {
      if (format === 'png') {
        const { dataUrl } = await captureViewportInSandbox(canvasSelector, resolution, 'image/png');
        const blob = await (await fetch(dataUrl)).blob();
        downloadBlob(blob, `${filename}.png`);
      } else {
        // PDF: JPEG raster (0.92 quality) embedded via DCTDecode XObject
        const { dataUrl, width, height } = await captureViewportInSandbox(
          canvasSelector, resolution, 'image/jpeg', 0.92,
        );
        const jpegBytes = dataUrlToBytes(dataUrl);
        const pdfBytes = buildPdfFromJpeg(jpegBytes, width, height);
        const pdfBlob = new Blob([pdfBytes as unknown as BlobPart], { type: 'application/pdf' });
        downloadBlob(pdfBlob, `${filename}.pdf`);
      }

      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Export failed';
      setError(message);
    } finally {
      setIsExporting(false);
    }
  }, [canvasSelector, resolution, format, filename, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
        className="bg-white rounded-xl shadow-2xl w-[420px] overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 id="export-dialog-title" className="text-base font-semibold text-gray-900">Export View</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-gray-100 text-gray-500"
            aria-label="Close export dialog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Format selector */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-2">Format</label>
            <div className="flex gap-2">
              <button
                onClick={() => setFormat('png')}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                  format === 'png'
                    ? 'border-cyan-500 bg-cyan-50 text-cyan-700'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                <ImageIcon className="w-4 h-4" />
                PNG
              </button>
              <button
                onClick={() => setFormat('pdf')}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                  format === 'pdf'
                    ? 'border-cyan-500 bg-cyan-50 text-cyan-700'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                <FileText className="w-4 h-4" />
                PDF
              </button>
            </div>
          </div>

          {/* Resolution */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-2">Resolution</label>
            <div className="flex gap-2">
              {([1, 2, 3] as ExportResolution[]).map((res) => (
                <button
                  key={res}
                  onClick={() => setResolution(res)}
                  className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                    resolution === res
                      ? 'border-cyan-500 bg-cyan-50 text-cyan-700'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {res}x {res === 1 ? '(Screen)' : res === 2 ? '(Print)' : '(HiDPI)'}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[10px] text-gray-400">
              Output is capped at 40 megapixels; PDF pages are sized in points.
            </p>
          </div>

          {/* Filename */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-2">Filename</label>
            <input
              type="text"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
              placeholder="scada-export"
            />
          </div>

          {/* Error */}
          {error && (
            <div className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg" role="alert">{error}</div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-200 bg-gray-50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleExport}
            disabled={isExporting || !filename.trim()}
            className={`flex items-center gap-2 px-4 py-2 text-sm text-white rounded-lg transition-colors ${
              isExporting || !filename.trim()
                ? 'bg-cyan-400 cursor-not-allowed'
                : 'bg-cyan-600 hover:bg-cyan-700'
            }`}
          >
            {isExporting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            {isExporting ? 'Exporting...' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ExportDialog;
