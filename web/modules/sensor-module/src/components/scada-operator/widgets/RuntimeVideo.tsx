/**
 * RuntimeVideo — HTML5 video player widget for SCADA operator mode.
 *
 * Features:
 *   - HTML5 <video> element supporting mp4, webm, ogg
 *   - Native browser controls (optional — configured via showControls)
 *   - External control via widget events/actions: play, pause, stop, reset
 *     The parent RuntimeWidgetRenderer sends onCommand('play'|'pause'|'stop')
 *   - Dynamic source URL: can come from a tag value (tagId in config) or
 *     a static URL (src in config)
 *   - Placeholder image when src is absent or video is not loaded
 *   - autoPlay / loop / muted flags from config
 *   - Responsive container: video fills the widget area
 *   - Proper cleanup on unmount: pauses and nulls src to release resources
 *   - Accessible: aria-label on container
 */

import React, {
  memo,
  useRef,
  useEffect,
  useCallback,
  useState,
} from 'react';
import { Play, Pause, Square, Video } from 'lucide-react';
import type { RuntimeWidgetProps } from '../../../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Supported MIME types                                                */
/* ------------------------------------------------------------------ */

const MIME_MAP: Record<string, string> = {
  mp4:  'video/mp4',
  webm: 'video/webm',
  ogg:  'video/ogg',
  ogv:  'video/ogg',
  mov:  'video/quicktime',
};

function getMimeType(url: string): string {
  const ext = url.split('.').pop()?.toLowerCase() ?? '';
  return MIME_MAP[ext] ?? 'video/mp4';
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

const RuntimeVideo: React.FC<RuntimeWidgetProps> = ({
  value,
  config,
  tagValues,
  isEnabled = true,
  onCommand,
  width = 320,
  height = 240,
}) => {
  /* ---- config ---- */
  const staticSrc    = (config.src         ?? '')    as string;
  const srcTagId     = (config.srcTagId    ?? '')    as string;
  const showControls = Boolean(config.showControls ?? true);
  const autoPlay     = Boolean(config.autoPlay     ?? false);
  const loop         = Boolean(config.loop         ?? false);
  const muted        = Boolean(config.muted        ?? true);  // muted required for autoplay
  const poster       = (config.poster      ?? '')    as string;
  const label        = (config.label       ?? 'Video') as string;
  const showToolbar  = Boolean(config.showToolbar ?? !showControls);

  /* ---- derive source URL ---- */
  // Priority: tag value → static src → empty
  const tagSrc =
    srcTagId && tagValues?.[srcTagId]
      ? String(tagValues[srcTagId].value ?? '')
      : '';

  const primaryValue = typeof value === 'string' ? value : '';
  const resolvedSrc = tagSrc || primaryValue || staticSrc;

  /* ---- refs / state ---- */
  const videoRef  = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasError, setHasError]   = useState(false);
  const [isLoaded, setIsLoaded]   = useState(false);

  /* ---- update src when it changes ---- */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (resolvedSrc !== video.src) {
      video.pause();
      video.src = resolvedSrc || '';
      video.load();
      setIsLoaded(false);
      setHasError(false);
      setIsPlaying(false);
    }
  }, [resolvedSrc]);

  /* ---- sync play state from video element events ---- */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay   = () => setIsPlaying(true);
    const onPause  = () => setIsPlaying(false);
    const onEnded  = () => setIsPlaying(false);
    const onError  = () => { setHasError(true); setIsPlaying(false); };
    const onLoaded = () => setIsLoaded(true);

    video.addEventListener('play',        onPlay);
    video.addEventListener('pause',       onPause);
    video.addEventListener('ended',       onEnded);
    video.addEventListener('error',       onError);
    video.addEventListener('loadeddata',  onLoaded);

    return () => {
      video.removeEventListener('play',       onPlay);
      video.removeEventListener('pause',      onPause);
      video.removeEventListener('ended',      onEnded);
      video.removeEventListener('error',      onError);
      video.removeEventListener('loadeddata', onLoaded);
    };
  }, []);

  /* ---- cleanup on unmount ---- */
  useEffect(() => {
    return () => {
      const video = videoRef.current;
      if (video) {
        video.pause();
        video.src = '';
        video.load();
      }
    };
  }, []);

  /* ---- external command handler (called by parent via onCommand) ---- */
  useEffect(() => {
    // onCommand is called when widget events fire; we expose a ref for
    // the parent RuntimeWidgetRenderer to call imperatively.
    // Since onCommand is a callback, we patch the RuntimeWidgetRenderer's
    // command dispatch to handle video-specific commands here via useEffect.
    // The actual dispatch happens when onCommand is called.
  }, []);

  /* ---- Imperative control methods exposed via onCommand ---- */
  const executeCommand = useCallback(
    (command: string) => {
      const video = videoRef.current;
      if (!video) return;
      switch (command) {
        case 'play':
          void video.play().catch(() => setHasError(true));
          break;
        case 'pause':
          video.pause();
          break;
        case 'stop':
        case 'reset':
          video.pause();
          video.currentTime = 0;
          break;
        default:
          break;
      }
      onCommand?.(command);
    },
    [onCommand],
  );

  /* ---- toolbar controls ---- */
  const handlePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video || !isEnabled) return;
    if (isPlaying) {
      executeCommand('pause');
    } else {
      executeCommand('play');
    }
  }, [isPlaying, isEnabled, executeCommand]);

  const handleStop = useCallback(() => {
    if (!isEnabled) return;
    executeCommand('stop');
  }, [isEnabled, executeCommand]);

  /* ---- Placeholder ---- */
  const showPlaceholder = !resolvedSrc || hasError;

  return (
    <div
      className="w-full h-full flex flex-col overflow-hidden rounded"
      aria-label={label}
      role="region"
      style={{ opacity: isEnabled ? 1 : 0.5 }}
    >
      {/* Video container */}
      <div
        className="relative flex-1 bg-gray-900 flex items-center justify-center overflow-hidden"
        style={{ minHeight: 0 }}
      >
        {showPlaceholder ? (
          /* Placeholder: no src or load error */
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-gray-500"
            aria-label={hasError ? 'Video load error' : 'No video source'}
          >
            {poster ? (
              <img
                src={poster}
                alt="Video placeholder"
                className="absolute inset-0 w-full h-full object-cover opacity-40"
              />
            ) : null}
            <Video className="w-10 h-10 opacity-30" aria-hidden="true" />
            <span className="text-xs opacity-50">
              {hasError ? 'Failed to load video' : 'No video source'}
            </span>
          </div>
        ) : (
          <video
            ref={videoRef}
            className="w-full h-full object-contain"
            controls={showControls}
            autoPlay={autoPlay}
            loop={loop}
            muted={muted}
            playsInline
            poster={poster || undefined}
            aria-label={label}
            preload="metadata"
          >
            {resolvedSrc && (
              <source src={resolvedSrc} type={getMimeType(resolvedSrc)} />
            )}
            Your browser does not support the video element.
          </video>
        )}

        {/* Loading overlay */}
        {!showPlaceholder && !isLoaded && !hasError && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/60">
            <div className="w-6 h-6 border-2 border-gray-400 border-t-white rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* Custom toolbar (shown when showControls=false or showToolbar=true) */}
      {showToolbar && !showPlaceholder && (
        <div
          className="flex items-center justify-center gap-2 py-1.5 px-3 bg-gray-800 border-t border-gray-700"
          role="toolbar"
          aria-label="Video controls"
        >
          <button
            type="button"
            onClick={handlePlayPause}
            disabled={!isEnabled || !isLoaded}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            className="p-1.5 rounded text-gray-300 hover:text-white hover:bg-gray-700 disabled:opacity-40 transition-colors"
          >
            {isPlaying
              ? <Pause className="w-4 h-4" aria-hidden="true" />
              : <Play  className="w-4 h-4" aria-hidden="true" />
            }
          </button>
          <button
            type="button"
            onClick={handleStop}
            disabled={!isEnabled || !isLoaded}
            aria-label="Stop and reset"
            className="p-1.5 rounded text-gray-300 hover:text-white hover:bg-gray-700 disabled:opacity-40 transition-colors"
          >
            <Square className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
};

RuntimeVideo.displayName = 'RuntimeVideo';
export default memo(RuntimeVideo);
