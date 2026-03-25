/**
 * Configuration panel for the Raster Image widget.
 * Handles image upload with MIME type validation (PNG, JPG, WebP, GIF only).
 * Shows file size warning for images > 100KB suggesting S3/MinIO upload.
 *
 * Images are stored as base64 data URIs in the widget config for simplicity.
 * Production deployments should upload to object storage and reference by URL.
 */

import React, { useCallback, useRef, useState } from 'react';
import { TransformConfig } from './TransformConfig';
import type { SvgTransform } from '../../../types/scada-transform.types';
import { DEFAULT_SVG_TRANSFORM } from '../../../types/scada-transform.types';

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

const INPUT_CLASS =
  'w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500';

/** Allowed MIME types for raster image upload */
const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const ACCEPT_ATTR = '.png,.jpg,.jpeg,.gif,.webp';

/** 5 MB hard limit -- reject entirely */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/** 100 KB soft limit -- warn but allow */
const WARN_FILE_SIZE = 100 * 1024;

const OBJECT_FIT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'contain', label: 'Contain' },
  { value: 'cover', label: 'Cover' },
  { value: 'fill', label: 'Fill' },
  { value: 'none', label: 'None' },
];

export const RasterImageConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const transform = (config.transform as SvgTransform) ?? DEFAULT_SVG_TRANSFORM;
  const imageSrc = (config.imageSrc as string) || (config.imageData as string) || '';

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setError(null);
      setWarning(null);
      const file = e.target.files?.[0];
      if (!file) return;

      // MIME type validation
      if (!ALLOWED_MIME_TYPES.has(file.type)) {
        setError(`Invalid file type: ${file.type}. Only PNG, JPG, GIF, and WebP are allowed.`);
        // Reset the input so the same file can be re-selected after fixing
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }

      // Hard size limit
      if (file.size > MAX_FILE_SIZE) {
        setError(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 5 MB.`);
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }

      // Soft size warning
      if (file.size > WARN_FILE_SIZE) {
        setWarning(
          `Large image (${(file.size / 1024).toFixed(0)} KB). Consider uploading to S3/MinIO for better performance.`,
        );
      }

      // Read as base64 data URI
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUri = ev.target?.result as string;
        onChange({ imageSrc: dataUri, imageData: dataUri });
      };
      reader.readAsDataURL(file);
    },
    [onChange],
  );

  const handleRemoveImage = useCallback(() => {
    onChange({ imageSrc: '', imageData: '' });
    setError(null);
    setWarning(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [onChange]);

  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Image</div>

      {/* Image preview */}
      {imageSrc && (
        <div className="relative">
          <img
            src={imageSrc}
            alt={(config.altText as string) || (config.alt as string) || 'Widget image'}
            className="w-full h-24 object-contain rounded-lg border border-gray-200 bg-gray-50"
          />
          <button
            type="button"
            onClick={handleRemoveImage}
            className="absolute top-1 right-1 w-5 h-5 bg-red-500 text-white rounded-full text-xs flex items-center justify-center hover:bg-red-600"
            aria-label="Remove image"
            title="Remove image"
          >
            X
          </button>
        </div>
      )}

      {/* Upload button */}
      <div>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_ATTR}
          onChange={handleFileChange}
          className="hidden"
          aria-label="Upload image file"
          data-testid="image-file-input"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="w-full py-2 text-sm text-cyan-700 bg-cyan-50 hover:bg-cyan-100 border border-cyan-200 rounded-lg transition-colors"
        >
          {imageSrc ? 'Replace Image' : 'Upload Image'}
        </button>
      </div>

      {/* Error / warning messages */}
      {error && (
        <div
          className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-2"
          role="alert"
          data-testid="image-error"
        >
          {error}
        </div>
      )}
      {warning && (
        <div
          className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg p-2"
          role="status"
          data-testid="image-warning"
        >
          {warning}
        </div>
      )}

      {/* Object fit */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Object Fit</label>
        <select
          value={(config.objectFit as string) || 'contain'}
          onChange={(e) => onChange({ objectFit: e.target.value })}
          className={INPUT_CLASS}
          aria-label="Object fit mode"
        >
          {OBJECT_FIT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Alt text (accessibility) */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Alt Text</label>
        <input
          type="text"
          value={(config.altText as string) || (config.alt as string) || ''}
          onChange={(e) => onChange({ altText: e.target.value, alt: e.target.value })}
          placeholder="Describe the image for accessibility"
          className={INPUT_CLASS}
          aria-label="Image alt text"
        />
      </div>

      {/* Border radius */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Border Radius</label>
        <input
          type="number"
          min={0}
          max={50}
          value={(config.borderRadius as number) ?? 0}
          onChange={(e) => onChange({ borderRadius: Number(e.target.value) })}
          className={INPUT_CLASS}
          aria-label="Border radius"
        />
      </div>

      {/* Opacity */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Opacity</label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={(config.opacity as number) ?? 1}
          onChange={(e) => onChange({ opacity: Number(e.target.value) })}
          className="w-full"
          aria-label="Image opacity"
        />
        <div className="text-xs text-gray-400 text-right">
          {Math.round(((config.opacity as number) ?? 1) * 100)}%
        </div>
      </div>

      {/* Transform section */}
      <TransformConfig
        transform={transform}
        onChange={(updates) => onChange({ transform: { ...transform, ...updates } })}
      />
    </div>
  );
};
