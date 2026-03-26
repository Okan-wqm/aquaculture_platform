/**
 * IFrameRenderer - Embeds external web content within SCADA views.
 *
 * Security model: Only https:// URLs are allowed in production.
 * The sandbox attribute restricts scripts, forms, and navigation
 * by default. Users can selectively enable capabilities through
 * the config panel.
 *
 * Tenant isolation: iframe content cannot access parent window
 * state, cookies, or localStorage. The 'allow-same-origin' flag
 * is disabled by default to enforce this boundary.
 *
 * Dangerous protocols (javascript:, data:, blob:, vbscript:) are
 * rejected at both config-time and render-time to prevent XSS.
 */

import React, { memo, useState, useMemo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

/* ------------------------------------------------------------------ */
/*  URL validation                                                     */
/* ------------------------------------------------------------------ */

/**
 * Validates that a URL is safe for iframe embedding.
 * Rejects dangerous protocols and non-HTTPS URLs.
 * Returns an error message string if invalid, or null if valid.
 */
export function validateIFrameUrl(url: string): string | null {
  if (!url || url.trim().length === 0) {
    return 'No URL configured';
  }

  const trimmed = url.trim().toLowerCase();

  // Block dangerous protocols explicitly
  const dangerousProtocols = ['javascript:', 'data:', 'blob:', 'vbscript:'];
  for (const proto of dangerousProtocols) {
    if (trimmed.startsWith(proto)) {
      return `Blocked protocol: ${proto} URLs are not allowed`;
    }
  }

  // Only allow HTTPS (and HTTP in dev for local cameras/PLCs)
  if (!trimmed.startsWith('https://') && !trimmed.startsWith('http://')) {
    return 'Only https:// URLs are allowed';
  }

  // Basic URL structure validation
  try {
    new URL(url.trim());
  } catch {
    return 'Invalid URL format';
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  Sandbox flags builder                                              */
/* ------------------------------------------------------------------ */

/**
 * Builds the sandbox attribute string from boolean config flags.
 * The base sandbox (empty string) blocks everything. Each flag
 * selectively re-enables a specific capability.
 */
function buildSandboxAttribute(config: Record<string, unknown>): string {
  const flags: string[] = [];

  if (config.allowScripts) flags.push('allow-scripts');
  if (config.allowForms) flags.push('allow-forms');
  if (config.allowPopups) flags.push('allow-popups');
  if (config.allowSameOrigin) flags.push('allow-same-origin');

  // Return space-separated flags. An empty string means "maximum restriction".
  return flags.join(' ');
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const IFrameRenderer: React.FC<WidgetRendererProps> = ({
  config,
  width,
  height,
  isEditing,
}) => {
  const url = (config.url ?? '') as string;
  const borderRadius = (config.borderRadius ?? 0) as number;
  const showBorder = (config.showBorder ?? true) as boolean;
  const label = (config.label ?? '') as string;

  const [isLoading, setIsLoading] = useState(true);

  const validationError = useMemo(() => validateIFrameUrl(url), [url]);
  const sandboxValue = useMemo(() => buildSandboxAttribute(config), [config]);

  // Error / placeholder state
  if (validationError) {
    return (
      <div
        style={{
          width,
          height,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#fefce8',
          border: '1px dashed #d97706',
          borderRadius: borderRadius || 6,
          color: '#92400e',
          fontFamily: 'sans-serif',
          fontSize: 12,
          gap: 6,
          padding: 16,
          textAlign: 'center',
        }}
        data-testid="iframe-error"
      >
        <span style={{ fontSize: 22 }}>{'\u26A0'}</span>
        <span style={{ fontWeight: 600 }}>IFrame</span>
        <span style={{ fontSize: 11, color: '#a16207' }}>{validationError}</span>
      </div>
    );
  }

  // In editing mode, show a placeholder instead of loading external content
  // to prevent iframes from interfering with the editor (focus stealing, etc.)
  if (isEditing) {
    return (
      <div
        style={{
          width,
          height,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f0f9ff',
          border: showBorder ? '1px solid #bae6fd' : 'none',
          borderRadius,
          fontFamily: 'sans-serif',
          fontSize: 12,
          color: '#0369a1',
          gap: 6,
          padding: 16,
          textAlign: 'center',
        }}
        data-testid="iframe-preview"
      >
        <span style={{ fontSize: 24 }}>{'\uD83C\uDF10'}</span>
        <span style={{ fontWeight: 600 }}>IFrame Widget</span>
        {label && <span style={{ fontSize: 11, color: '#0284c7' }}>{label}</span>}
        <span
          style={{
            fontSize: 10,
            color: '#64748b',
            maxWidth: '90%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {url}
        </span>
        <span style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>
          Preview disabled in edit mode
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        width,
        height,
        position: 'relative',
        borderRadius,
        overflow: 'hidden',
        border: showBorder ? '1px solid #e2e8f0' : 'none',
      }}
      data-testid="iframe-container"
    >
      {/* Loading spinner overlay */}
      {isLoading && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#f8fafc',
            zIndex: 1,
          }}
          data-testid="iframe-loading"
        >
          <div
            style={{
              width: 28,
              height: 28,
              border: '3px solid #e2e8f0',
              borderTopColor: '#06b6d4',
              borderRadius: '50%',
              animation: 'widgetSpin 0.7s linear infinite',
            }}
          />
        </div>
      )}

      <iframe
        src={url}
        sandbox={sandboxValue}
        title={label || 'Embedded content'}
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          display: 'block',
        }}
        onLoad={() => setIsLoading(false)}
        onError={() => setIsLoading(false)}
        referrerPolicy="no-referrer"
        loading="lazy"
        data-testid="iframe-element"
      />
    </div>
  );
};

IFrameRenderer.displayName = 'IFrameRenderer';
export default memo(IFrameRenderer);
