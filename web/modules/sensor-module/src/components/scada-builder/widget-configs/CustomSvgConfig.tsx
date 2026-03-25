/**
 * CustomSvgConfig - Properties panel for the Custom SVG import widget
 *
 * Allows the user to upload a `.svg` file, displays the current file name,
 * and provides a remove button. Also exposes an optional label field.
 *
 * Security: Upload sirasinda dosya boyutu, SVG root elementi ve DOMPurify
 * sanitizasyonu uygulanir.
 */

import React, { useCallback, useRef, useState } from 'react';
import { Upload, Trash2, AlertCircle } from 'lucide-react';
import DOMPurify from 'dompurify';

// Guvenlik: SVG dosya boyutu limiti -- buyuk dosyalar package JSON'i sisirir
// ve base64 encode edildiginde ~33% daha buyuk olur
// Security: 500KB cap prevents oversized payloads in SCADA package store
const MAX_SVG_SIZE_BYTES = 500 * 1024; // 500KB

// DOMPurify config -- renderer ile ayni config'i kullanir
// Upload sirasinda da sanitize ederek store'a temiz veri yazilir
const DOMPURIFY_CONFIG: DOMPurify.Config = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ['foreignObject', 'script', 'iframe', 'embed', 'object', 'base', 'form'],
  FORBID_ATTR: ['xlink:href', 'formaction', 'action', 'srcdoc'],
  ADD_TAGS: [
    'use', 'symbol', 'defs', 'clipPath', 'mask', 'pattern', 'marker',
    'linearGradient', 'radialGradient', 'stop', 'filter',
    'feGaussianBlur', 'feOffset', 'feMerge', 'feMergeNode', 'feFlood',
    'feComposite', 'feBlend', 'feColorMatrix',
  ],
  ALLOW_DATA_ATTR: false,
};

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

export const CustomSvgConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasSvg = Boolean(config.svgContent);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !file.name.endsWith('.svg')) return;

    setUploadError(null);

    // Guvenlik: Dosya boyutu kontrolu -- buyuk SVG'ler store ve API payload'unu patlatir
    // Security: reject files exceeding 500KB to prevent oversized SCADA packages
    if (file.size > MAX_SVG_SIZE_BYTES) {
      setUploadError(`File too large (${(file.size / 1024).toFixed(0)}KB). Maximum: 500KB`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    const text = await file.text();
    const trimmed = text.trim();

    // Guvenlik: SVG root element dogrulamasi -- sadece gecerli SVG kabul edilir
    // Security: validates file starts with <svg or <?xml to reject non-SVG content
    if (!trimmed.startsWith('<svg') && !trimmed.startsWith('<?xml')) {
      setUploadError('Invalid SVG file. File must start with <svg> or <?xml>.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    // Guvenlik: Upload sirasinda DOMPurify sanitizasyonu
    // Security: sanitize at upload time so malicious content never enters the store
    const sanitized = DOMPurify.sanitize(text, DOMPURIFY_CONFIG);

    // Extract viewBox dimensions if available
    const vbMatch = sanitized.match(/viewBox\s*=\s*["']([^"']+)["']/);
    const updates: Record<string, unknown> = { svgContent: sanitized, svgFileName: file.name };
    if (vbMatch) {
      updates.svgViewBox = vbMatch[1];
    }
    onChange(updates);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [onChange]);

  const handleRemove = useCallback(() => {
    setUploadError(null);
    onChange({ svgContent: undefined, svgFileName: undefined, svgViewBox: undefined });
  }, [onChange]);

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 mb-1">SVG File</label>
        {hasSvg ? (
          <div className="flex items-center justify-between px-3 py-2 bg-green-50 border border-green-200 rounded-lg">
            <span className="text-xs text-green-700 truncate">
              {(config.svgFileName as string) || 'custom.svg'}
            </span>
            <button onClick={handleRemove} className="text-red-400 hover:text-red-600 ml-2">
              <Trash2 size={14} />
            </button>
          </div>
        ) : (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full flex items-center justify-center gap-2 px-3 py-3 border-2 border-dashed border-gray-300 rounded-lg text-xs text-gray-500 hover:border-cyan-400 hover:text-cyan-600 transition-colors"
          >
            <Upload size={14} />
            Upload SVG
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".svg"
          className="hidden"
          onChange={handleFileSelect}
        />
        {/* Upload hata mesaji -- kullaniciya neden reddedildigini gosterir */}
        {uploadError && (
          <div className="flex items-center gap-1.5 mt-1.5 px-2 py-1.5 bg-red-50 border border-red-200 rounded text-xs text-red-600">
            <AlertCircle size={12} className="flex-shrink-0" />
            <span>{uploadError}</span>
          </div>
        )}
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Label</label>
        <input
          type="text"
          value={(config.label as string) || ''}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Optional label"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>
    </div>
  );
};
