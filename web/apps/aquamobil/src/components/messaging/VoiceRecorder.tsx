/**
 * @module VoiceRecorder
 * @description Voice note recording UI with microphone button, timer display,
 * waveform visualization (CSS bars animation), and cancel/stop controls.
 *
 * WHY tap-to-toggle: Hold-to-record requires continuous finger pressure,
 * which is difficult with wet/gloved hands (common in aquaculture). Tap
 * to start + tap to stop is the most reliable UX for field workers.
 *
 * WHY 48dp buttons: Google Material Design minimum touch target for mobile.
 * Field workers often have large/wet hands.
 *
 * @see ADR-012 section 5.3 (Voice Notes)
 */

import { clsx } from 'clsx';
import { Mic, Square, X } from 'lucide-react';
import { useCallback, useMemo, type ReactElement } from 'react';

import { IconButton } from '@/components/ui';
import { useVoiceRecorder } from '@/hooks/useVoiceRecorder';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VoiceRecorderProps {
  /** Callback when recording is completed with an audio Blob. */
  onRecordingComplete: (blob: Blob, durationSeconds: number, mimeType: string) => void;
  /** Callback to dismiss the recorder and return to text input mode. */
  onCancel: () => void;
  /** Whether recording controls should be disabled. */
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of animated waveform bars. */
const WAVEFORM_BAR_COUNT = 24;

/** Maximum allowed recording duration in seconds. */
const MAX_DURATION_SECONDS = 300; // 5 minutes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format seconds to MM:SS display.
 * @param seconds - Elapsed seconds
 * @returns Formatted time string
 */
function formatTimer(seconds: number): string {
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Waveform bars sub-component
// ---------------------------------------------------------------------------

/**
 * Animated waveform visualization using CSS animations.
 * Each bar has a randomized delay and height to simulate audio waveform.
 */
function WaveformBars({ isAnimating }: { isAnimating: boolean }): ReactElement {
  // Generate stable random heights for bars (seeded by index)
  const bars = useMemo(
    () =>
      Array.from({ length: WAVEFORM_BAR_COUNT }, (_, i) => ({
        key: i,
        delay: `${(i * 0.07) % 0.5}s`,
        minHeight: 4 + (i % 3) * 2,
        maxHeight: 12 + ((i * 7) % 20),
      })),
    [],
  );

  return (
    <div className="flex items-center gap-[2px] h-8 px-2">
      {bars.map((bar) => (
        <div
          key={bar.key}
          className={clsx(
            'w-[3px] rounded-full transition-all',
            // Coral is the live-recording signal here, matching the record dot
            // and the timer — the one thing that says "this is capturing now".
            isAnimating ? 'bg-crit animate-pulse' : 'bg-line-strong',
          )}
          style={{
            height: isAnimating ? `${bar.maxHeight}px` : `${bar.minHeight}px`,
            animationDelay: bar.delay,
            animationDuration: '0.6s',
            transition: 'height 0.15s ease-in-out',
          }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * VoiceRecorder -- recording interface that replaces the text input bar
 * when the user taps the microphone button.
 */
export function VoiceRecorder({
  onRecordingComplete,
  onCancel,
  disabled = false,
}: VoiceRecorderProps): ReactElement {
  const {
    state,
    elapsedSeconds,
    mimeType,
    startRecording,
    stopRecording,
    cancelRecording,
    isSupported,
    error,
  } = useVoiceRecorder();

  const isRecording = state === 'recording';
  const isNearLimit = elapsedSeconds >= MAX_DURATION_SECONDS - 30;

  /** Handle record / stop toggle. */
  const handleToggleRecord = useCallback(async () => {
    if (disabled) return;

    if (state === 'idle') {
      await startRecording();
    } else if (isRecording) {
      const blob = await stopRecording();
      if (blob && blob.size > 0) {
        onRecordingComplete(blob, elapsedSeconds, mimeType);
      }
    }
  }, [
    disabled,
    state,
    isRecording,
    startRecording,
    stopRecording,
    onRecordingComplete,
    elapsedSeconds,
    mimeType,
  ]);

  /** Handle cancel. */
  const handleCancel = useCallback(() => {
    if (isRecording) {
      cancelRecording();
    }
    onCancel();
  }, [isRecording, cancelRecording, onCancel]);

  // Browser does not support MediaRecorder
  if (!isSupported) {
    // An unsupported browser is a WATCH, not an alarm: nothing broke, one input
    // mode is simply unavailable. Amber, not coral.
    return (
      <div className="flex items-center gap-3 px-4 py-3 bg-warn-dim rounded-lg">
        <Mic size={20} className="text-warn shrink-0" />
        <p className="text-meta text-warn">
          Voice recording is not supported in this browser. Please use Chrome, Firefox, or Safari.
        </p>
        <IconButton onClick={onCancel} className="hover:bg-warn-dim" aria-label="Close">
          <X size={18} className="text-warn" />
        </IconButton>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      {/* Cancel button */}
      <IconButton
        size="lg"
        onClick={handleCancel}
        className="hover:bg-surface-2 transition-colors"
        aria-label="Cancel recording"
      >
        <X size={22} className="text-ink-2" />
      </IconButton>

      {/* Waveform + timer */}
      <div className="flex-1 flex items-center gap-2 min-w-0">
        {/* Recording indicator dot */}
        {isRecording && <div className="w-2.5 h-2.5 rounded-full bg-crit animate-pulse shrink-0" />}

        {/* Waveform visualization */}
        <div className="flex-1 overflow-hidden">
          <WaveformBars isAnimating={isRecording} />
        </div>

        {/* Timer */}
        <span
          className={clsx(
            // The near-limit state now differs by WEIGHT only, because coral is
            // already the recording colour — a second red would say nothing.
            'text-body font-mono tabular-nums shrink-0 min-w-[48px] text-center',
            isRecording ? (isNearLimit ? 'text-crit font-bold' : 'text-crit') : 'text-ink-2',
          )}
        >
          {formatTimer(elapsedSeconds)}
        </span>
      </div>

      {/* Record / Stop button */}
      <IconButton
        size="lg"
        onClick={() => {
          void handleToggleRecord();
        }}
        disabled={disabled}
        className={clsx(
          'transition-all',
          isRecording ? 'bg-crit shadow-token' : 'bg-acc shadow-acc',
        )}
        aria-label={isRecording ? 'Stop recording' : 'Start recording'}
      >
        {isRecording ? (
          // White on crit matches the kit's `danger` Button — coral is dark
          // enough to carry white ink in all three themes.
          <Square size={20} className="text-white" fill="currentColor" />
        ) : (
          <Mic size={20} className="text-acc-on" />
        )}
      </IconButton>

      {/* Error message */}
      {error && (
        <div className="absolute bottom-full left-0 right-0 px-4 pb-2">
          <p className="text-meta text-crit bg-crit-dim px-3 py-1.5 rounded-lg">{error}</p>
        </div>
      )}
    </div>
  );
}
