/**
 * CustomSvgConfig - Properties panel for the Custom SVG import widget
 *
 * Allows the user to upload a `.svg` file, displays the current file name,
 * and provides a remove button. Also exposes an optional label field.
 *
 * Security: Upload-time file size check, SVG root element validation,
 * and DOMPurify sanitization are applied before storing the content.
 *
 * Phase 7A: Added SvgTagBindingSection for opt-in data binding,
 * TransformConfig for rotation/scale/skew, and opacity slider.
 * These were missing from the original config, preventing custom SVGs
 * from participating in the animation/transform pipeline.
 */

import React, { useCallback, useRef, useState } from 'react';
import { Button, Input, Slider } from '@aquaculture/shared-ui';
import { Upload, Trash2, AlertCircle } from 'lucide-react';
import DOMPurify from 'dompurify';
import { SvgTagBindingSection } from './SvgTagBindingSection';
import { TransformConfig } from './TransformConfig';
import type { SvgTransform } from '../../../types/scada-transform.types';
import { DEFAULT_SVG_TRANSFORM } from '../../../types/scada-transform.types';

// Security: 500KB cap prevents oversized payloads in SCADA package store
const MAX_SVG_SIZE_BYTES = 500 * 1024; // 500KB

// DOMPurify config -- must match the renderer's config exactly so that
// what is stored is identical to what is rendered after re-sanitization
const DOMPURIFY_CONFIG: Parameters<typeof DOMPurify.sanitize>[1] = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ['foreignObject', 'script', 'iframe', 'embed', 'object', 'base', 'form'],
  FORBID_ATTR: ['xlink:href', 'formaction', 'action', 'srcdoc'],
  ADD_TAGS: [
    'use',
    'symbol',
    'defs',
    'clipPath',
    'mask',
    'pattern',
    'marker',
    'linearGradient',
    'radialGradient',
    'stop',
    'filter',
    'feGaussianBlur',
    'feOffset',
    'feMerge',
    'feMergeNode',
    'feFlood',
    'feComposite',
    'feBlend',
    'feColorMatrix',
  ],
  ALLOW_DATA_ATTR: false,
};

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

export const CustomSvgConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasSvg = Boolean(config.svgContent);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const transform = (config.transform as SvgTransform) ?? DEFAULT_SVG_TRANSFORM;

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !file.name.endsWith('.svg')) return;

      setUploadError(null);

      // Security: reject files exceeding 500KB to prevent oversized SCADA packages
      if (file.size > MAX_SVG_SIZE_BYTES) {
        setUploadError(`File too large (${(file.size / 1024).toFixed(0)}KB). Maximum: 500KB`);
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }

      const text = await file.text();
      const trimmed = text.trim();

      // Security: validates file starts with <svg or <?xml to reject non-SVG content
      if (!trimmed.startsWith('<svg') && !trimmed.startsWith('<?xml')) {
        setUploadError('Invalid SVG file. File must start with <svg> or <?xml>.');
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }

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
    },
    [onChange],
  );

  const handleRemove = useCallback(() => {
    setUploadError(null);
    onChange({ svgContent: undefined, svgFileName: undefined, svgViewBox: undefined });
  }, [onChange]);

  return (
    <div className="space-y-3">
      {/* Tag binding -- opt-in data binding for animation/event/alarm system */}
      <SvgTagBindingSection
        tagName={(config.tagName as string) || ''}
        onChange={onChange}
        deviceId={deviceId}
      />

      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">SVG File</label>
        {hasSvg ? (
          <div className="flex items-center justify-between px-3 py-2 bg-success-50 dark:bg-success-900/20 border border-success-200 dark:border-success-800 rounded-lg">
            <span className="text-xs text-success-700 dark:text-success-300 truncate">
              {(config.svgFileName as string) || 'custom.svg'}
            </span>
            <Button
              variant="ghost"
              iconOnly
              aria-label="Delete"
              className="ml-2"
              onClick={handleRemove}
            >
              <Trash2 size={14} />
            </Button>
          </div>
        ) : (
          <Button
            variant="secondary"
            size="xs"
            className="justify-center"
            leftIcon={<Upload size={14} />}
            onClick={() => fileInputRef.current?.click()}
          >
            Upload SVG
          </Button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".svg"
          className="hidden"
          onChange={handleFileSelect}
        />
        {/* Upload error message -- shows the user why the file was rejected */}
        {uploadError && (
          <div className="flex items-center gap-1.5 mt-1.5 px-2 py-1.5 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded text-xs text-error-600 dark:text-error-400">
            <AlertCircle size={12} className="flex-shrink-0" />
            <span>{uploadError}</span>
          </div>
        )}
      </div>
      <Input
        label="Label"
        value={(config.label as string) || ''}
        onChange={(e) => onChange({ label: e.target.value })}
        placeholder="Optional label"
      />

      {/* Opacity slider -- allows the entire custom SVG to be semi-transparent */}
      <Slider
        size="xs"
        label="Opacity"
        readout="below"
        formatValue={(v) => `${Math.round(v * 100)}%`}
        min={0}
        max={1}
        step={0.05}
        value={(config.opacity as number) ?? 1}
        onChange={(opacity) => onChange({ opacity })}
        data-testid="custom-svg-opacity"
      />

      {/* Transform section -- rotation, scale, skew for custom SVGs */}
      <TransformConfig
        transform={transform}
        onChange={(updates) => onChange({ transform: { ...transform, ...updates } })}
      />
    </div>
  );
};
