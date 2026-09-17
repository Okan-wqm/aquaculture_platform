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

import { IconButton } from '@/components/ui';

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

  // Secondary text: on-accent ink inside an own (accent-filled) bubble, the
  // muted ink ramp otherwise. Dimmed with `opacity-*` rather than a colour
  // alpha, because Tailwind emits no rule at all for an alpha on `var(--x)`.
  const META_TEXT = isOwn ? 'text-acc-on opacity-75' : 'text-ink-3';

  return (
    <div className="flex items-center gap-2 py-1 min-w-[200px] max-w-[280px]">
      {/* Play/Pause button.
          WHY the own side inverts (on-accent fill, accent glyph) instead of a
          translucent white: the own bubble is already filled with the accent, so
          a wash of the same hue would not separate. The inverted pair reads as a
          control in all three themes, from one class rather than two. */}
      <IconButton
        size="lg"
        onClick={() => {
          void handlePlayPause();
        }}
        className={clsx('shrink-0 transition-colors', isOwn ? 'bg-acc-on' : 'bg-acc-dim')}
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? (
          <Pause size={18} className="text-acc" fill="currentColor" />
        ) : (
          <Play size={18} className="text-acc" fill="currentColor" />
        )}
      </IconButton>

      {/* Waveform + progress */}
      <div className="flex-1 min-w-0">
        {/* Waveform bars with progress overlay */}
        <div
          className="flex items-center gap-[1px] h-6 cursor-pointer relative focus:outline-none focus:ring-2 focus:ring-acc rounded"
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
                  // Played vs unplayed on the own side is ONE colour at two
                  // strengths: the token layer has no alpha channel, so the
                  // dimming is a plain opacity utility.
                  isOwn ? 'bg-acc-on' : isActive ? 'bg-acc' : 'bg-line-strong',
                  isOwn && !isActive && 'opacity-30',
                )}
                style={{ height: `${(height / 100) * 24}px` }}
              />
            );
          })}
        </div>

        {/* Duration display. text-meta is 12px, the sunlight-readability floor;
            it replaces a 10px arbitrary size, lowering the tiny-text ratchet. */}
        <div className="flex items-center justify-between mt-0.5">
          <span className={clsx('text-meta tabular-nums', META_TEXT)}>
            {formatDuration(currentTime)}
          </span>
          <span className={clsx('text-meta tabular-nums', META_TEXT)}>
            {formatDuration(duration)}
          </span>
        </div>
      </div>

      {/* Speed toggle — IconButton bakes in the 44px touch floor (MOB-MEDIUM-009;
          replaces the prior 28px target that failed gloved outdoor use). */}
      <IconButton
        onClick={handleSpeedToggle}
        className={clsx(
          'text-meta font-bold transition-colors',
          isOwn ? 'bg-acc-on text-acc' : 'bg-surface-3 text-ink-2',
        )}
        aria-label={`Playback speed ${speed}x`}
      >
        {speed}x
      </IconButton>
    </div>
  );
}
