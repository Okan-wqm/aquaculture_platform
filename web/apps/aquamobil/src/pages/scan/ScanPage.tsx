/**
 * ScanPage — point the camera at the QR tag on a unit's rail and go there.
 *
 * The dock's raised centre button leads here, because scanning is how a worker
 * standing at a pen tells the app which pen they mean. Typing a code with wet
 * gloves while holding a net is the thing this replaces.
 *
 * DEGRADATION IS DELIBERATE AND VISIBLE. `BarcodeDetector` is not available in
 * every browser (notably iOS Safari at time of writing) and a camera can be
 * refused. This screen still renders its full framing and offers the unit list
 * as a manual path, rather than disappearing — a control that vanishes on some
 * devices teaches workers not to trust it. The old BarcodeScanButton returns
 * null on unsupported devices, which is right for a small inline affordance and
 * wrong for a destination the dock always shows.
 *
 * The camera is released on unmount, on a successful hit, and on navigating
 * away — a live rear camera left running is a battery and privacy problem.
 */
import { Keyboard, ScanLine, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Card, EmptyState } from '@/components/ui';
import { useTanks } from '@/hooks/useTanks';
import type { Tank } from '@/types';
import { logger } from '@/utils/logger';

/** Minimal structural typing for the (not-yet-in-lib.dom) BarcodeDetector. */
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

function getBarcodeDetectorCtor(): BarcodeDetectorConstructor | null {
  const candidate = (globalThis as Record<string, unknown>)['BarcodeDetector'];
  return typeof candidate === 'function' ? (candidate as BarcodeDetectorConstructor) : null;
}

const DETECT_INTERVAL_MS = 300;

/**
 * Resolve a decoded string to a unit.
 *
 * Tags in the field are inconsistent: some encode the bare code ("U-07"), some a
 * URL ending in it, some the container UUID. Matching on the last path segment
 * case-insensitively against id, code and name covers all three without asking
 * the farm to re-print its tags.
 */
export function resolveScannedUnit(raw: string, tanks: readonly Tank[]): Tank | null {
  const value = raw.trim();
  if (!value) return null;
  // Drop the query and fragment BEFORE taking the last path segment — splitting
  // on all three at once makes "…/U-03?src=rail" resolve to "src=rail".
  const path = value.split(/[?#]/)[0] ?? value;
  const tail = (path.split('/').filter(Boolean).pop() ?? path).toLowerCase();
  return (
    tanks.find(
      (t) =>
        t.id.toLowerCase() === tail ||
        t.code.toLowerCase() === tail ||
        t.name.toLowerCase() === tail,
    ) ?? null
  );
}

type ScanState =
  | { kind: 'idle' }
  | { kind: 'scanning' }
  | { kind: 'hit'; tank: Tank }
  | { kind: 'unknown'; value: string; listUnavailable: boolean }
  | { kind: 'unsupported' }
  | { kind: 'denied' };

export function ScanPage(): ReactElement {
  const navigate = useNavigate();
  const { data: tanks } = useTanks();
  const [state, setState] = useState<ScanState>({ kind: 'idle' });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Read inside the polling callback so it always sees the latest list without
  // restarting the camera every time the query refetches.
  const tanksRef = useRef<readonly Tank[]>([]);
  tanksRef.current = tanks ?? [];

  const stop = useCallback((): void => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async (): Promise<void> => {
    const DetectorCtor = getBarcodeDetectorCtor();
    if (!DetectorCtor) {
      setState({ kind: 'unsupported' });
      return;
    }
    setState({ kind: 'scanning' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const detector = new DetectorCtor({ formats: ['qr_code', 'code_128', 'code_39'] });
      intervalRef.current = setInterval(() => {
        const video = videoRef.current;
        if (!video) return;
        void detector
          .detect(video)
          .then((codes) => {
            const value = codes[0]?.rawValue;
            if (!value) return;
            stop();
            const tank = resolveScannedUnit(value, tanksRef.current);
            // A tag that decodes but matches nothing is a real state — a tag
            // from another site, or a unit this user cannot see. Saying so
            // beats silently continuing to scan.
            // With no unit list loaded, "not recognised" would be an
            // authorisation claim manufactured from a network failure.
            setState(
              tank
                ? { kind: 'hit', tank }
                : { kind: 'unknown', value, listUnavailable: tanksRef.current.length === 0 },
            );
          })
          .catch((error: unknown) => {
            logger.debug('[scan] detect frame failed', error);
          });
      }, DETECT_INTERVAL_MS);
    } catch (error) {
      logger.warn('[scan] camera unavailable', error);
      stop();
      setState({ kind: 'denied' });
    }
  }, [stop]);

  // Open the camera on arrival — the worker tapped Scan, so asking them to tap
  // again is a wasted step with a glove on.
  useEffect(() => {
    void start();
    return stop;
  }, [start, stop]);

  // A hit navigates after a beat so the confirmation is actually seen.
  useEffect(() => {
    if (state.kind !== 'hit') return undefined;
    const id = setTimeout(() => navigate(`/tank/${state.tank.id}`), 650);
    return () => clearTimeout(id);
  }, [state, navigate]);

  const close = (): void => {
    stop();
    navigate(-1);
  };

  return (
    <div className="fixed inset-0 z-30 bg-surface-0 flex flex-col">
      <div className="flex items-center gap-3 px-4 pt-safe-top">
        <button
          type="button"
          onClick={close}
          aria-label="Cancel scan"
          className="w-10 h-10 min-h-touch min-w-touch rounded-xl bg-surface-2 inline-flex items-center justify-center touch-feedback focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc"
        >
          <X size={18} className="text-ink-2" />
        </button>
        <div className="py-4">
          <div className="text-head font-semibold text-ink-1">Scan unit tag</div>
          <div className="text-body text-ink-3">
            Stand at the unit and aim at the QR on the rail
          </div>
        </div>
      </div>

      {/* Viewfinder — always rendered, so the screen has the same shape whether
          or not this device can decode. */}
      <div className="relative mx-4 rounded-3xl overflow-hidden bg-black aspect-[3/4] max-h-[54vh]">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          playsInline
          muted
        >
          {/* No audio in a viewfinder, so there is nothing to caption; an empty
              track satisfies media-has-caption honestly. */}
          <track kind="captions" />
        </video>

        {/* Corner brackets + travelling scan line. */}
        <span
          aria-hidden
          className="absolute left-4 top-4 w-8 h-8 border-l-2 border-t-2 border-acc rounded-tl-lg"
        />
        <span
          aria-hidden
          className="absolute right-4 top-4 w-8 h-8 border-r-2 border-t-2 border-acc rounded-tr-lg"
        />
        <span
          aria-hidden
          className="absolute left-4 bottom-4 w-8 h-8 border-l-2 border-b-2 border-acc rounded-bl-lg"
        />
        <span
          aria-hidden
          className="absolute right-4 bottom-4 w-8 h-8 border-r-2 border-b-2 border-acc rounded-br-lg"
        />
        {state.kind === 'scanning' && (
          <span
            aria-hidden
            className="absolute left-6 right-6 h-0.5 bg-acc shadow-acc animate-am-scan"
          />
        )}

        {state.kind === 'hit' && (
          <div className="absolute inset-0 bg-black/70 flex items-center justify-center animate-am-fade">
            <Card className="px-5 py-4 text-center animate-am-pop">
              <div className="text-head font-mono font-semibold text-ink-1">{state.tank.code}</div>
              <div className="text-body text-ink-3">{state.tank.name}</div>
              <div className="text-meta font-mono text-acc mt-2">OPENING</div>
            </Card>
          </div>
        )}
      </div>

      <div className="flex-1 px-4 py-5" role="status" aria-live="polite">
        {state.kind === 'scanning' && (
          <p className="text-body text-ink-3 text-center">Looking for a tag…</p>
        )}

        {state.kind === 'unknown' && (
          <EmptyState
            tone="error"
            icon={<ScanLine size={22} />}
            title={state.listUnavailable ? 'Units not loaded' : 'Tag not recognised'}
            description={
              state.listUnavailable
                ? `Read "${state.value}", but the unit list is unavailable so it cannot be matched. Check your connection and scan again.`
                : `"${state.value}" does not match a unit you have access to. It may belong to another site.`
            }
            action={
              <Button variant="primary" onClick={() => void start()}>
                Scan again
              </Button>
            }
          />
        )}

        {(state.kind === 'unsupported' || state.kind === 'denied') && (
          <EmptyState
            icon={<Keyboard size={22} />}
            title={
              state.kind === 'unsupported' ? 'This device cannot decode tags' : 'Camera unavailable'
            }
            description={
              state.kind === 'unsupported'
                ? 'This browser has no barcode decoder. Pick the unit from the list instead — everything else works the same.'
                : 'Camera access was refused or is in use. Pick the unit from the list instead.'
            }
            action={
              <Button variant="primary" onClick={() => navigate('/units')}>
                Choose from units
              </Button>
            }
          />
        )}
      </div>
    </div>
  );
}

export default ScanPage;
