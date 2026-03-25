import React, { memo, useState, useEffect, useRef, useCallback } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

type StreamMode = 'mjpeg' | 'hls' | 'image';

/**
 * Guvenlik: Sadece http/https URL'lere izin ver -- SSRF ve injection onlemi
 * Security: rejects javascript:, data:, blob:, file: and other dangerous protocols
 * to prevent XSS and SSRF attacks through video/image sources
 */
function isValidStreamUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

const VideoStreamRenderer: React.FC<WidgetRendererProps> = ({ config, width, height, isEditing }) => {
  const streamUrl = (config.streamUrl ?? '') as string;
  const mode = (config.streamMode ?? 'mjpeg') as StreamMode;
  const refreshInterval = (config.refreshInterval ?? 5) as number;
  const label = (config.label ?? '') as string;
  const showControls = (config.showControls ?? true) as boolean;

  const [refreshKey, setRefreshKey] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-refresh for image mode
  useEffect(() => {
    if (mode !== 'image' || !streamUrl || isEditing) return;
    const timer = setInterval(() => setRefreshKey((k) => k + 1), refreshInterval * 1000);
    return () => clearInterval(timer);
  }, [mode, streamUrl, refreshInterval, isEditing]);

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => { /* noop */ });
    } else {
      document.exitFullscreen().catch(() => { /* noop */ });
    }
    // Not: State güncelleme artık fullscreenchange event'inde yapılıyor
    // Note: State update is now handled in the fullscreenchange event listener below
  }, []);

  /**
   * Browser uyumu: Kullanıcı Escape ile fullscreen'den çıktığında
   * toggleFullscreen çağrılmaz — React state eski kalır. Bu listener
   * browser'ın fullscreen durumunu her zaman React state ile senkronize eder.
   *
   * Browser compatibility: When the user exits fullscreen via Escape key,
   * toggleFullscreen is not called — React state goes stale. This listener
   * always syncs the browser's fullscreen state with React state.
   */
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Placeholder when no URL
  if (!streamUrl) {
    return (
      <div style={{
        width, height, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', background: '#1f2937', borderRadius: 8, color: '#6b7280',
        fontSize: 11, gap: 8,
      }}>
        <svg width={32} height={32} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
        <span>No stream URL</span>
      </div>
    );
  }

  // Guvenlik: URL protokol dogrulamasi -- javascript:, data: gibi tehlikeli protokoller engellenir
  // Security: show warning placeholder instead of rendering unsafe URL sources
  if (!isValidStreamUrl(streamUrl)) {
    return (
      <div style={{
        width, height, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', background: '#1f2937', borderRadius: 8, color: '#f87171',
        fontSize: 11, gap: 8, padding: 12, textAlign: 'center',
      }}>
        <svg width={32} height={32} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>Invalid stream URL</span>
        <span style={{ fontSize: 9, color: '#9ca3af' }}>Only http:// and https:// URLs are allowed</span>
      </div>
    );
  }

  const headerH = label ? 24 : 0;
  const contentH = height - headerH;

  return (
    <div ref={containerRef} style={{ width, height, background: '#000', borderRadius: 4, overflow: 'hidden', position: 'relative' }}>
      {/* Label header */}
      {label && (
        <div style={{
          height: headerH, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 8px', background: 'rgba(0,0,0,0.7)', color: '#fff', fontSize: 10, fontWeight: 600,
        }}>
          <span>{label}</span>
          <button onClick={toggleFullscreen} type="button" style={{
            background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 10,
          }}>
            {isFullscreen ? '\u229E' : '\u229F'}
          </button>
        </div>
      )}

      {/* Stream content */}
      {mode === 'hls' ? (
        <video
          src={streamUrl}
          style={{ width: '100%', height: contentH, objectFit: 'contain' }}
          autoPlay
          muted
          playsInline
          controls={showControls}
        />
      ) : (
        <img
          key={mode === 'image' ? refreshKey : undefined}
          src={mode === 'image' ? `${streamUrl}${streamUrl.includes('?') ? '&' : '?'}t=${Date.now()}` : streamUrl}
          alt={label || 'Camera stream'}
          style={{ width: '100%', height: contentH, objectFit: 'contain', display: 'block' }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
      )}

      {/* Status dot -- green when active */}
      <div style={{
        position: 'absolute', top: label ? headerH + 4 : 4, right: 4,
        width: 8, height: 8, borderRadius: '50%', background: '#22c55e',
        boxShadow: '0 0 4px rgba(34,197,94,0.6)',
      }} />
    </div>
  );
};

VideoStreamRenderer.displayName = 'VideoStreamRenderer';
export default memo(VideoStreamRenderer);
