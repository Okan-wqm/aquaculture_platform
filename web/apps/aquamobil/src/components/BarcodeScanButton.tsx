import { ScanLine, X } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';

import { logger } from '@/utils/logger';

/**
 * MOB-MEDIUM-010 (barcode half): scan-to-find for warehouse floor flows.
 *
 * Progressive enhancement over the BarcodeDetector API — devices without it
 * (or without a camera) render NOTHING, so the plain search input stays the
 * universal path and no capability is faked. On supported devices the button
 * opens a rear-camera overlay, polls the detector, and hands the first decoded
 * value to the caller (which uses it as the item search/filter text).
 */

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

export function BarcodeScanButton({
  onScan,
}: {
  onScan: (value: string) => void;
}): ReactElement | null {
  const [isScanning, setIsScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopScanning = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setIsScanning(false);
  }, []);

  const startScanning = useCallback(async () => {
    const DetectorCtor = getBarcodeDetectorCtor();
    if (!DetectorCtor) return;
    setIsScanning(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const detector = new DetectorCtor({
        formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8'],
      });
      intervalRef.current = setInterval(() => {
        const video = videoRef.current;
        if (!video) return;
        void detector
          .detect(video)
          .then((barcodes) => {
            const value = barcodes[0]?.rawValue;
            if (value) {
              stopScanning();
              onScan(value);
            }
          })
          .catch((error: unknown) => {
            logger.debug('[barcode] detect frame failed', error);
          });
      }, DETECT_INTERVAL_MS);
    } catch (error) {
      logger.warn('[barcode] camera unavailable', error);
      stopScanning();
    }
  }, [onScan, stopScanning]);

  // Release the camera if the component unmounts mid-scan.
  useEffect(() => stopScanning, [stopScanning]);

  if (!getBarcodeDetectorCtor()) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => void startScanning()}
        aria-label="Scan barcode"
        className="min-h-touch min-w-touch flex items-center justify-center rounded-xl border border-line bg-surface-1 text-acc touch-feedback"
      >
        <ScanLine size={20} />
      </button>

      {isScanning && (
        <div className="fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center">
          <video ref={videoRef} className="w-full max-h-[70vh] object-contain" playsInline muted>
            {/* Live camera viewfinder: no audio, hence no spoken content to
                caption. An empty captions track satisfies media-has-caption
                honestly instead of suppressing the rule. */}
            <track kind="captions" />
          </video>
          {/* WHY plain white here and not `text-ink-1`: the ink ramp is defined
              against the app's surfaces, and this text sits on a live camera
              feed behind a near-opaque black scrim. White-on-scrim is legible in
              all three themes precisely because it does NOT follow them. */}
          <p className="text-white text-body font-medium mt-4">
            Point the camera at a barcode or QR code
          </p>
          <button
            type="button"
            onClick={stopScanning}
            aria-label="Cancel scan"
            className="mt-4 min-h-touch px-6 flex items-center gap-2 rounded-xl bg-white/15 text-white font-semibold touch-feedback"
          >
            <X size={18} />
            Cancel
          </button>
        </div>
      )}
    </>
  );
}
