/**
 * Raster Image renderer -- displays PNG/JPG/WebP images as widgets.
 * Supports data URLs and remote URLs with configurable object-fit.
 *
 * Images > 500 KB data URLs are converted to Blob URLs on mount
 * to reduce JSON parse overhead in the SCADA package store.
 * The Blob URL is revoked on unmount to prevent memory leaks.
 */

import React, { memo, useEffect, useMemo, useState } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

/** Threshold above which data URLs are converted to Blob URLs for performance */
const BLOB_THRESHOLD_BYTES = 500 * 1024;

type ObjectFitValue = 'contain' | 'cover' | 'fill' | 'none';

/** Only allow safe URL protocols to prevent javascript: injection */
function isValidImageUrl(url: string): boolean {
  if (!url) return false;
  try {
    // data: URLs don't parse well with URL constructor, handle separately
    if (url.startsWith('data:image/')) return true;
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Converts a data URL to a Blob URL. Returns null if the input is not
 * a data URL or conversion fails. The caller is responsible for revoking
 * the returned URL via URL.revokeObjectURL().
 */
function dataUrlToBlobUrl(dataUrl: string): string | null {
  try {
    const [header, base64Data] = dataUrl.split(',');
    if (!header || !base64Data) return null;
    const mimeMatch = header.match(/data:(.*?);/);
    if (!mimeMatch) return null;
    const mime = mimeMatch[1];
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mime });
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

const RasterImageRenderer: React.FC<WidgetRendererProps> = ({
  config, width, height, isEditing, animationState,
}) => {
  const imageData = (config.imageData ?? '') as string;
  const objectFit = (config.objectFit ?? 'contain') as ObjectFitValue;
  const alt = (config.alt ?? 'SCADA image widget') as string;
  const borderRadius = (config.borderRadius ?? 0) as number;
  const opacity = (config.opacity ?? 1) as number;

  // Validate URL before rendering
  const validUrl = isValidImageUrl(imageData);

  // Convert large data URLs to Blob URLs to avoid JSON serialization overhead
  const isLargeDataUrl = imageData.startsWith('data:') && imageData.length > BLOB_THRESHOLD_BYTES;

  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  // Create blob URL for large data URLs
  useEffect(() => {
    if (!isLargeDataUrl) {
      setBlobUrl(null);
      return;
    }
    const url = dataUrlToBlobUrl(imageData);
    setBlobUrl(url);
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [imageData, isLargeDataUrl]);

  const displayUrl = useMemo(() => {
    if (blobUrl) return blobUrl;
    return validUrl ? imageData : '';
  }, [blobUrl, validUrl, imageData]);

  // Visibility from animation — evaluated AFTER all hooks so the hook call
  // order stays identical across renders (react-hooks/rules-of-hooks). An
  // invisible widget still runs its blob-URL effect, which is harmless.
  if (animationState && !animationState.visible) {
    return <div style={{ width, height, opacity: 0 }} />;
  }

  // Animation styles
  const containerStyle: React.CSSProperties = { width, height, overflow: 'hidden' };
  if (animationState?.rotating) {
    const dir = animationState.rotationDirection === 'ccw' ? 'reverse' : 'normal';
    containerStyle.animation = `scada-rotate ${animationState.rotationSpeed}ms linear infinite ${dir}`;
    containerStyle.transformOrigin = 'center center';
  }
  if (animationState?.blinking) {
    containerStyle.animation = `scada-blink ${animationState.blinkInterval}ms ease-in-out infinite`;
  }

  // Show upload placeholder when no image data is present
  if (!displayUrl) {
    if (!isEditing) {
      return <div style={{ width, height }} />;
    }
    return (
      <div style={{
        width, height, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        background: '#f8fafc', border: '2px dashed #d1d5db', borderRadius: 8,
        color: '#9ca3af', fontSize: 11, textAlign: 'center', padding: 8, gap: 4,
      }}>
        <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <rect x={3} y={3} width={18} height={18} rx={2} />
          <circle cx={8.5} cy={8.5} r={1.5} />
          <path d="M21 15l-5-5L5 21" />
        </svg>
        <span>Upload image</span>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <img
        src={displayUrl}
        alt={alt}
        loading="lazy"
        decoding="async"
        style={{
          width: '100%',
          height: '100%',
          objectFit,
          borderRadius,
          opacity,
          display: 'block',
        }}
      />
    </div>
  );
};

RasterImageRenderer.displayName = 'RasterImageRenderer';
export default memo(RasterImageRenderer);
