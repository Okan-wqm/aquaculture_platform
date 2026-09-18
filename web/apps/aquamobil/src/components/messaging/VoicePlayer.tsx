/**
 * @module VoicePlayer
 * @description Voice note playback UI with play/pause, seekable progress bar,
 * duration display, playback speed toggle, and static waveform visualization.
 *
 * WHY HTML5 Audio API: Native browser audio playback is battery-efficient
 * and handles codec negotiation. The Web Audio API adds unnecessary
 * complexity for simple playback.
 *
 * WHY 48dp touch targets: Google Material Design minimum for mobile.
 *
 * @see ADR-012 section 5.3 (Voice Notes)
 */

import { clsx } from 'clsx';
import { Play, Pause } from 'lucide-react';
import { useState, useRef, useCallback, useEffect, useMemo, type ReactElement } from 'react';

import { IconButton } from '../ui/IconButton';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VoicePlayerProps {
  /** Presigned download URL for the audio file. */
  src: string;
  /** Duration in seconds (from message metadata). Falls back to Audio duration. */
  durationSeconds?: number;
  /** Whether the bubble is from the current user (affects colors). */
  isOwn?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Playback speed options. */
const SPEED_OPTIONS = [1, 1.5, 2] as const;
type PlaybackSpeed = (typeof SPEED_OPTIONS)[number];

/** Number of static waveform bars. */
const BAR_COUNT = 32;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format seconds to M:SS display.
 * @param seconds - Time in seconds
 * @returns Formatted string like "1:23"
 */
function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const min = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);
  return `${min}:${String(sec).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * VoicePlayer -- compact audio player for voice note messages.
 */
export function VoicePlayer({
  src,
  durationSeconds,
  isOwn = false,
}: VoicePlayerProps): ReactElement {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(durationSeconds ?? 0);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);

  // Generate stable bar heights for the waveform
  const barHeights = useMemo(
    () =>
      Array.from({ length: BAR_COUNT }, (_, i) => {
        // Deterministic pseudo-random heights based on index
        const seed = ((i * 2654435761) >>> 0) % 100;
        return 20 + (seed % 80); // 20-100% height
      }),
    [],
  );

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  // Initialize audio element
  useEffect(() => {
    const audio = new Audio(src);
    audio.preload = 'metadata';
    audioRef.current = audio;

    const handleLoadedMetadata = (): void => {
      if (isFinite(audio.duration)) {
        setDuration(audio.duration);
      }
    };

    const handleTimeUpdate = (): void => {
      setCurrentTime(audio.currentTime);
    };

    const handleEnded = (): void => {
      setIsPlaying(false);
      setCurrentTime(0);
      audio.currentTime = 0;
    };

    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('ended', handleEnded);
      audio.pause();
      audio.src = '';
    };
  }, [src]);

  // Sync playback speed
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = speed;
    }
  }, [speed]);

  /** Toggle play/pause. */
  const handlePlayPause = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      try {
        await audio.play();
        setIsPlaying(true);
      } catch {
        // Autoplay blocked or other error — silently handle
        setIsPlaying(false);
      }
    }
  }, [isPlaying]);

  /** Seek within the audio via progress bar click. */
  const handleSeek = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const audio = audioRef.current;
      if (!audio || duration === 0) return;

      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));
      const newTime = ratio * duration;

      audio.currentTime = newTime;
      setCurrentTime(newTime);
    },
    [duration],
  );

  /** Cycle through playback speeds. */
  const handleSpeedToggle = useCallback(() => {
    setSpeed((prev) => {
      const idx = SPEED_OPTIONS.indexOf(prev);
      return SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length];
    });
  }, []);

  /**
   * Keyboard seek: Left/Right arrows nudge playback ±5s, Home/End jump to the
   * ends. WHY: the progress bar is an interactive seek surface, so it must be
   * keyboard operable for assistive-technology and physical-keyboard users.
   */
  const handleSeekKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      const audio = audioRef.current;
      if (!audio || duration === 0) return;

      const SEEK_STEP = 5;
      let nextTime: number | null = null;
      switch (e.key) {
        case 'ArrowLeft':
          nextTime = Math.max(0, audio.currentTime - SEEK_STEP);
          break;
        case 'ArrowRight':
          nextTime = Math.min(duration, audio.currentTime + SEEK_STEP);
          break;
        case 'Home':
          nextTime = 0;
          break;
        case 'End':
          nextTime = duration;
          break;
        default:
          return;
      }

      e.preventDefault();
      audio.currentTime = nextTime;
      setCurrentTime(nextTime);
    },
    [duration],
  );

  return (
    <div className="flex items-center gap-2 py-1 min-w-[200px] max-w-[280px]">
      {/* Play/Pause button */}
      <button
        onClick={() => {
          void handlePlayPause();
        }}
        className={clsx(
          'min-w-[48px] min-h-[48px] flex items-center justify-center rounded-full shrink-0 touch-feedback transition-colors',
          isOwn
            ? 'bg-white/20 hover:bg-white/30'
            : 'bg-ocean-50 dark:bg-ocean-900/30 hover:bg-ocean-100 dark:hover:bg-ocean-900/50',
        )}
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? (
          <Pause
            size={18}
            className={isOwn ? 'text-white' : 'text-ocean-600 dark:text-ocean-400'}
            fill="currentColor"
          />
        ) : (
          <Play
            size={18}
            className={isOwn ? 'text-white' : 'text-ocean-600 dark:text-ocean-400'}
            fill="currentColor"
          />
        )}
      </button>

      {/* Waveform + progress */}
      <div className="flex-1 min-w-0">
        {/* Waveform bars with progress overlay */}
        <div
          className="flex items-center gap-[1px] h-6 cursor-pointer relative focus:outline-none focus:ring-2 focus:ring-ocean-500/40 rounded"
          onClick={handleSeek}
          onKeyDown={handleSeekKey}
          role="slider"
          tabIndex={0}
          aria-valuenow={Math.round(progress)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Seek audio position"
        >
          {barHeights.map((height, i) => {
            const barProgress = ((i + 1) / BAR_COUNT) * 100;
            const isActive = barProgress <= progress;
            return (
              <div
                key={i}
                className={clsx(
                  'w-[2px] rounded-full transition-colors',
                  isActive
                    ? isOwn
                      ? 'bg-white'
                      : 'bg-ocean-600 dark:bg-ocean-400'
                    : isOwn
                      ? 'bg-white/30'
                      : 'bg-gray-300 dark:bg-gray-600',
                )}
                style={{ height: `${(height / 100) * 24}px` }}
              />
            );
          })}
        </div>

        {/* Duration display */}
        <div className="flex items-center justify-between mt-0.5">
          <span
            className={clsx(
              'text-[10px] tabular-nums',
              isOwn ? 'text-white/75' : 'text-gray-400 dark:text-gray-500',
            )}
          >
            {formatDuration(currentTime)}
          </span>
          <span
            className={clsx(
              'text-[10px] tabular-nums',
              isOwn ? 'text-white/75' : 'text-gray-400 dark:text-gray-500',
            )}
          >
            {formatDuration(duration)}
          </span>
        </div>
      </div>

      {/* Speed toggle — IconButton bakes in the 44px touch floor (MOB-MEDIUM-009;
          replaces the prior 28px target that failed gloved outdoor use). */}
      <IconButton
        onClick={handleSpeedToggle}
        className={clsx(
          'text-[10px] font-bold transition-colors',
          isOwn
            ? 'bg-white/20 text-white hover:bg-white/30'
            : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600',
        )}
        aria-label={`Playback speed ${speed}x`}
      >
        {speed}x
      </IconButton>
    </div>
  );
}
