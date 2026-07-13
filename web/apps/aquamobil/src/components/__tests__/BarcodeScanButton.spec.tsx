// MOB-MEDIUM-010 (barcode half) — scan-to-find for warehouse floor flows.
//
// Stock receiving/dispensing/transfer identified items by scrolling a manual
// list; a printed barcode/QR on the sack or shelf is the industrial way in.
// BarcodeScanButton is a progressive enhancement over the BarcodeDetector API:
// devices without it (or without a camera) simply never see the button — the
// search input remains the universal path.

import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { BarcodeScanButton } from '../BarcodeScanButton';

class FakeBarcodeDetector {
  static detections: Array<{ rawValue: string }> = [];
  detect(): Promise<Array<{ rawValue: string }>> {
    return Promise.resolve(FakeBarcodeDetector.detections);
  }
}

const stopTrack = vi.fn();

function stubCamera(): void {
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [{ stop: stopTrack }],
      }),
    },
  });
}

describe('BarcodeScanButton (MOB-MEDIUM-010)', () => {
  beforeEach(() => {
    vi.stubGlobal('BarcodeDetector', FakeBarcodeDetector);
    stubCamera();
    FakeBarcodeDetector.detections = [];
    stopTrack.mockClear();
    // jsdom has no HTMLMediaElement.play
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders nothing when BarcodeDetector is unsupported (progressive enhancement)', () => {
    vi.unstubAllGlobals();
    const { container } = render(<BarcodeScanButton onScan={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('opens the camera overlay and delivers the first detected code', async () => {
    const onScan = vi.fn();
    FakeBarcodeDetector.detections = [{ rawValue: 'FEED-0042' }];
    render(<BarcodeScanButton onScan={onScan} />);

    fireEvent.click(screen.getByRole('button', { name: 'Scan barcode' }));

    await waitFor(() => expect(onScan).toHaveBeenCalledWith('FEED-0042'));
    // The camera stream is released after a successful scan.
    await waitFor(() => expect(stopTrack).toHaveBeenCalled());
  });

  it('cancel closes the overlay and releases the camera without scanning', async () => {
    const onScan = vi.fn();
    render(<BarcodeScanButton onScan={onScan} />);

    fireEvent.click(screen.getByRole('button', { name: 'Scan barcode' }));
    await screen.findByRole('button', { name: 'Cancel scan' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel scan' }));

    await waitFor(() => expect(stopTrack).toHaveBeenCalled());
    expect(onScan).not.toHaveBeenCalled();
  });
});
