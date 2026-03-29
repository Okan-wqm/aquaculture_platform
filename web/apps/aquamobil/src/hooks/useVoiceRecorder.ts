/**
 * @module useVoiceRecorder
 * @description MediaRecorder lifecycle hook for voice note recording.
 * Handles microphone permission, recording state, timer, and Blob output.
 * Supports audio/webm;codecs=opus (Chrome/Firefox) with audio/mp4 fallback (Safari).
 *
 * WHY MediaRecorder over Web Audio API: MediaRecorder provides a simple,
 * battery-efficient recording API. The Web Audio API would give waveform
 * data but consumes significantly more CPU, draining mobile batteries.
 *
 * WHY max 5 minutes: Voice notes longer than 5 minutes should be file
 * attachments. Auto-stop prevents accidentally recording a long meeting.
 */

import { useState, useRef, useCallback, useEffect } from 'react';

/** Recording states */
export type VoiceRecorderState = 'idle' | 'recording' | 'paused';

/** MIME type preference order. First supported type wins. */
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const;

/** Maximum recording duration in milliseconds (5 minutes). */
const MAX_DURATION_MS = 5 * 60 * 1000;

/** Timer tick interval in milliseconds. */
const TIMER_INTERVAL_MS = 1000;

interface UseVoiceRecorderReturn {
  /** Current recording state. */
  state: VoiceRecorderState;
  /** Elapsed recording time in seconds. */
  elapsedSeconds: number;
  /** The selected MIME type for recording. */
  mimeType: string;
  /** Start recording. Requests microphone permission if needed. */
  startRecording: () => Promise<void>;
  /** Stop recording and return the audio Blob. */
  stopRecording: () => Promise<Blob | null>;
  /** Cancel recording without producing output. */
  cancelRecording: () => void;
  /** Whether the browser supports MediaRecorder with a suitable codec. */
  isSupported: boolean;
  /** Error message if recording failed. */
  error: string | null;
}

/**
 * Detect the best supported MIME type for MediaRecorder.
 * Returns the first candidate that isTypeSupported(), or null if none work.
 */
function detectMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const candidate of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Voice recorder hook providing MediaRecorder lifecycle management.
 *
 * @returns Recording controls, state, elapsed time, and error info
 */
export function useVoiceRecorder(): UseVoiceRecorderReturn {
  const [state, setState] = useState<VoiceRecorderState>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resolveStopRef = useRef<((blob: Blob | null) => void) | null>(null);

  const detectedMime = useRef(detectMimeType());
  const isSupported = detectedMime.current !== null;
  const mimeType = detectedMime.current ?? 'audio/webm';

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  /** Stop the interval timer. */
  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** Release the microphone stream. */
  const releaseStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  /** Start recording. Requests microphone permission on first call. */
  const startRecording = useCallback(async () => {
    if (!isSupported) {
      setError('Voice recording is not supported in this browser.');
      return;
    }

    setError(null);
    chunksRef.current = [];
    setElapsedSeconds(0);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 48000,
        },
      });
      streamRef.current = stream;

      const recorder = new MediaRecorder(stream, {
        mimeType: detectedMime.current ?? undefined,
      });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];
        stopTimer();
        releaseStream();
        setState('idle');

        if (resolveStopRef.current) {
          resolveStopRef.current(blob);
          resolveStopRef.current = null;
        }
      };

      recorder.onerror = () => {
        setError('Recording failed. Please try again.');
        stopTimer();
        releaseStream();
        setState('idle');
        if (resolveStopRef.current) {
          resolveStopRef.current(null);
          resolveStopRef.current = null;
        }
      };

      // Start recording with 250ms timeslice for progressive data collection
      recorder.start(250);
      setState('recording');

      // Start elapsed timer
      timerRef.current = setInterval(() => {
        setElapsedSeconds((prev) => {
          const next = prev + 1;
          // Auto-stop at max duration
          if (next >= MAX_DURATION_MS / 1000) {
            recorder.stop();
          }
          return next;
        });
      }, TIMER_INTERVAL_MS);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Microphone access denied';
      if (msg.includes('NotAllowedError') || msg.includes('Permission')) {
        setError('Microphone permission denied. Please allow access in browser settings.');
      } else {
        setError(`Could not start recording: ${msg}`);
      }
      releaseStream();
    }
  }, [isSupported, mimeType, stopTimer, releaseStream]);

  /** Stop recording and return the captured audio Blob. */
  const stopRecording = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        resolve(null);
        return;
      }

      resolveStopRef.current = resolve;
      recorder.stop();
    });
  }, []);

  /** Cancel recording without producing output. */
  const cancelRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      // Clear the resolve callback so onstop does not emit a blob
      resolveStopRef.current = null;
      recorder.stop();
    }
    chunksRef.current = [];
    stopTimer();
    releaseStream();
    setState('idle');
    setElapsedSeconds(0);
  }, [stopTimer, releaseStream]);

  return {
    state,
    elapsedSeconds,
    mimeType,
    startRecording,
    stopRecording,
    cancelRecording,
    isSupported,
    error,
  };
}
