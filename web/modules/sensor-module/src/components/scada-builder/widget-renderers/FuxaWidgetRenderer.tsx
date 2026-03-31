/**
 * Renders a FUXA SVG widget inside a sandboxed iframe with full
 * JavaScript interactivity. This is the core renderer that makes
 * 1,450+ community widgets work in our SCADA builder.
 *
 * Security model:
 * - iframe sandbox="allow-scripts" (no allow-same-origin)
 * - srcdoc attribute (no external URL)
 * - CSP meta tag restricts network access
 * - postMessage bridge is the only communication channel
 *
 * Performance:
 * - IntersectionObserver defers iframe creation until visible
 * - Outbound messages batched via requestAnimationFrame
 * - Iframe srcdoc only set once (not on every re-render)
 *
 * The srcdoc contains:
 * 1. The FUXA SVG content (with its <script> block)
 * 2. A postMessage relay script that bridges putValue/postValue
 * 3. A CSP meta tag blocking network access
 *
 * Why no DOMPurify: FUXA widgets require their embedded JavaScript
 * to function. DOMPurify would strip the <script> tags, breaking
 * all interactivity. Security is enforced at the iframe sandbox
 * level instead -- the script runs but cannot escape its sandbox.
 */

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import { FuxaMessageBridge } from '../fuxa-bridge/FuxaMessageBridge';
import type { FuxaWidgetConfig, FuxaStateRule } from '../fuxa-bridge/types';
import { evaluateStateRules, parseFuxaExportVariables } from '../fuxa-bridge/types';

/* ------------------------------------------------------------------ */
/*  srcdoc template builder                                            */
/* ------------------------------------------------------------------ */

/**
 * Builds the complete HTML document that runs inside the sandboxed
 * iframe. The document includes:
 *
 * 1. A strict CSP meta tag that blocks all network access (no fetch,
 *    no image loading, no style imports) -- only inline scripts and
 *    styles are allowed.
 *
 * 2. The raw FUXA SVG content, including its embedded <script> block.
 *    This is NOT sanitized because the script is required for widget
 *    functionality. Security is enforced by the iframe sandbox.
 *
 * 3. A relay script that:
 *    - Listens for putValue messages from the parent and calls the
 *      SVG's putValue function
 *    - Overrides the SVG's postValue function to relay values back
 *      to the parent via postMessage
 */
export function buildFuxaSrcdoc(svgContent: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
  <style>body{margin:0;overflow:hidden;display:flex;align-items:center;justify-content:center;width:100vw;height:100vh;}svg{max-width:100%;max-height:100%;}</style>
</head>
<body>
  ${svgContent}
  <script>
    /**
     * SEC-L10: Capture the parent origin for restricted postMessage targeting.
     *
     * This iframe runs with sandbox="allow-scripts" (no allow-same-origin),
     * so its own origin is 'null'. We capture the parent's origin from the
     * first incoming putValue message (which comes from our trusted bridge)
     * and use it as the targetOrigin for all outbound postMessage calls.
     *
     * This prevents SCADA control values from leaking to untrusted windows:
     * - Before the first message: outbound calls are queued (not sent to '*')
     * - After the first message: outbound calls target only the verified parent origin
     *
     * The parent-side FuxaMessageBridge also validates event.source to ensure
     * only messages from THIS iframe's contentWindow are accepted.
     */
    var _trustedParentOrigin = null;
    var _pendingOutbound = [];

    // Bridge relay: forward putValue from parent into the SVG's putValue function
    window.addEventListener('message', function(e) {
      // SEC-L10: Capture and validate the parent origin on first contact.
      // Only accept messages that look like our bridge protocol (have type + id).
      if (e.data && typeof e.data.type === 'string' && typeof e.data.id === 'string') {
        if (!_trustedParentOrigin && e.origin && e.origin !== 'null') {
          _trustedParentOrigin = e.origin;
          // Flush any queued outbound messages now that we know the parent origin
          for (var i = 0; i < _pendingOutbound.length; i++) {
            window.parent.postMessage(_pendingOutbound[i], _trustedParentOrigin);
          }
          _pendingOutbound = [];
        }
      }
      if (e.data && e.data.type === 'putValue' && typeof putValue === 'function') {
        putValue(e.data.id, e.data.value);
      }
    });

    /**
     * SEC-L10: Safe postMessage wrapper that only sends to verified parent origin.
     * If the parent origin is not yet known (no putValue received yet), messages
     * are queued and flushed once the parent origin is established.
     */
    function _safePostToParent(msg) {
      if (_trustedParentOrigin) {
        window.parent.postMessage(msg, _trustedParentOrigin);
      } else {
        _pendingOutbound.push(msg);
      }
    }

    // Override SVG's postValue to relay user interactions back to parent
    var _origPostValue = typeof postValue === 'function' ? postValue : function(){};
    postValue = function(id, value) {
      _safePostToParent({type:'postValue', id:id, value:value});
    };
  </script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const FuxaWidgetRenderer: React.FC<WidgetRendererProps> = ({
  config,
  width,
  height,
  isEditing,
  value,
}) => {
  const fuxaConfig = config as unknown as FuxaWidgetConfig;
  const svgContent = fuxaConfig.svgContent || '';
  const variables = fuxaConfig.variables || {};
  const stateRules = fuxaConfig.stateRules || [];
  const variableTagBindings = fuxaConfig.variableTagBindings || {};
  const label = (config.label as string) || '';

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<FuxaMessageBridge | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  // Parse export variables once from SVG content
  const exportVariables = useMemo(
    () => parseFuxaExportVariables(svgContent),
    [svgContent],
  );

  // Build srcdoc only when SVG content changes (not on every variable update)
  const srcdoc = useMemo(() => {
    if (!svgContent) return '';
    return buildFuxaSrcdoc(svgContent);
  }, [svgContent]);

  /* ---------------------------------------------------------------- */
  /*  IntersectionObserver: defer iframe until scrolled into view      */
  /* ---------------------------------------------------------------- */

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isEditing) return; // No observer needed in edit mode
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.1 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [isEditing]);

  /* ---------------------------------------------------------------- */
  /*  Bridge lifecycle: create on iframe load, dispose on unmount      */
  /* ---------------------------------------------------------------- */

  const handleIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    // Dispose previous bridge if any (defensive)
    bridgeRef.current?.dispose();

    // Create new bridge (tagBus is null for now -- will be connected
    // when ScadaRuntimeContext provides it via a future hook)
    const bridge = new FuxaMessageBridge(iframe, null);
    bridgeRef.current = bridge;

    // Push current variable values into the iframe
    for (const [varId, varValue] of Object.entries(variables)) {
      bridge.sendValue(varId, varValue);
    }

    // Evaluate state rules if tag value is available
    if (typeof value === 'number' && stateRules.length > 0) {
      const stateIndex = evaluateStateRules(value, stateRules);
      // FUXA convention: _pn_setState drives the visual state
      bridge.sendValue('_pn_setState', stateIndex);
    }
  }, [variables, value, stateRules]);

  // Cleanup bridge on unmount
  useEffect(() => {
    return () => {
      bridgeRef.current?.dispose();
      bridgeRef.current = null;
    };
  }, []);

  // Push variable updates when they change after initial load
  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge) return;

    for (const [varId, varValue] of Object.entries(variables)) {
      bridge.sendValue(varId, varValue);
    }
  }, [variables]);

  // Push state index when tag value changes
  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    if (typeof value !== 'number' || stateRules.length === 0) return;

    const stateIndex = evaluateStateRules(value, stateRules as FuxaStateRule[]);
    bridge.sendValue('_pn_setState', stateIndex);
  }, [value, stateRules]);

  /* ---------------------------------------------------------------- */
  /*  Empty state: no SVG uploaded yet                                 */
  /* ---------------------------------------------------------------- */

  if (!svgContent) {
    return (
      <div
        style={{
          width,
          height,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f0fdf4',
          border: '1px dashed #86efac',
          borderRadius: 6,
          color: '#166534',
          fontFamily: 'sans-serif',
          fontSize: 12,
          gap: 6,
          padding: 16,
          textAlign: 'center',
        }}
        data-testid="fuxa-empty"
      >
        <span style={{ fontSize: 22 }}>{'\u2699'}</span>
        <span style={{ fontWeight: 600 }}>FUXA Widget</span>
        <span style={{ fontSize: 11, color: '#15803d' }}>
          Upload an SVG from the FUXA community library
        </span>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Edit mode: show preview placeholder (no iframe in editor)        */
  /* ---------------------------------------------------------------- */

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
          background: '#f0fdf4',
          border: '1px solid #bbf7d0',
          borderRadius: 6,
          fontFamily: 'sans-serif',
          fontSize: 12,
          color: '#166534',
          gap: 4,
          padding: 12,
          textAlign: 'center',
          overflow: 'hidden',
        }}
        data-testid="fuxa-preview"
      >
        <span style={{ fontSize: 20 }}>{'\u2699'}</span>
        <span style={{ fontWeight: 600 }}>FUXA Widget</span>
        {label && <span style={{ fontSize: 11, color: '#15803d' }}>{label}</span>}
        <span style={{ fontSize: 10, color: '#64748b' }}>
          {exportVariables.length} variable{exportVariables.length !== 1 ? 's' : ''} detected
        </span>
        <span style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
          Live preview in runtime mode
        </span>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Runtime mode: sandboxed iframe with full interactivity           */
  /* ---------------------------------------------------------------- */

  return (
    <div
      ref={containerRef}
      style={{
        width,
        height,
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 4,
      }}
      data-testid="fuxa-container"
    >
      {isVisible && (
        <iframe
          ref={iframeRef}
          srcDoc={srcdoc}
          sandbox="allow-scripts"
          title={label || 'FUXA Widget'}
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            display: 'block',
          }}
          onLoad={handleIframeLoad}
          data-testid="fuxa-iframe"
        />
      )}
    </div>
  );
};

FuxaWidgetRenderer.displayName = 'FuxaWidgetRenderer';
export default memo(FuxaWidgetRenderer);
