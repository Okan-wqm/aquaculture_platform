/**
 * Export utility tests.
 *
 * jsdom has no canvas rasterizer, so the byte-embedding functions are
 * tested with FAKE JPEG bytes (a minimal JPEG structure with the real SOI
 * marker) — verifying the produced PDF embeds the JPEG via /DCTDecode and
 * has a parseable xref table.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPdfFromJpeg,
  computePdfPageSize,
  pdfDiagnostics,
  capResolution,
  sanitizeCssValue,
  MAX_EXPORT_PIXELS,
} from '../exportUtils';

/** Minimal fake JPEG: SOI (FFD8) + APP0-ish bytes + EOI (FFD9). */
function fakeJpeg(size = 256): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes[0] = 0xff;
  bytes[1] = 0xd8; // SOI
  bytes[2] = 0xff;
  bytes[3] = 0xe0; // APP0 marker
  bytes[size - 2] = 0xff;
  bytes[size - 1] = 0xd9; // EOI
  return bytes;
}

describe('buildPdfFromJpeg', () => {
  it('produces a PDF that declares /Filter /DCTDecode and embeds the JPEG SOI bytes', () => {
    const jpeg = fakeJpeg();
    const pdf = buildPdfFromJpeg(jpeg, 640, 480);

    const latin1 = new TextDecoder('latin1').decode(pdf);
    expect(latin1.startsWith('%PDF-1.4')).toBe(true);
    expect(latin1).toContain('/Filter /DCTDecode');
    expect(latin1).toContain('/Subtype /Image');
    expect(latin1).toContain('/Width 640');
    expect(latin1).toContain('/Height 480');

    // The JPEG stream itself is present, byte-for-byte
    const diagnostics = pdfDiagnostics(pdf);
    expect(diagnostics.headerOk).toBe(true);
    expect(diagnostics.hasSoiMarker).toBe(true);
  });

  it('embeds the exact JPEG bytes in the stream object', () => {
    const jpeg = fakeJpeg(512);
    const pdf = buildPdfFromJpeg(jpeg, 100, 100);
    // Locate the raw JPEG inside the PDF bytes
    let found = false;
    outer: for (let i = 0; i <= pdf.length - jpeg.length; i++) {
      for (let j = 0; j < jpeg.length; j++) {
        if (pdf[i + j] !== jpeg[j]) continue outer;
      }
      found = true;
      break;
    }
    expect(found).toBe(true);
  });

  it('has a parseable xref whose offsets point at "N 0 obj"', () => {
    const pdf = buildPdfFromJpeg(fakeJpeg(128), 320, 240);
    const latin1 = new TextDecoder('latin1').decode(pdf);

    const { xrefOffsets } = pdfDiagnostics(pdf);
    expect(xrefOffsets.length).toBe(5); // objects 1..5
    for (const offset of xrefOffsets) {
      // Each offset must land exactly on an object header
      const slice = latin1.slice(offset, offset + 12);
      expect(/\d 0 obj/.test(slice)).toBe(true);
    }
    expect(latin1).toContain('startxref');
    expect(latin1.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('sizes the page in POINTS scaled to fit — never raw pixels', () => {
    // 2x export of a 1920×1080 canvas → 3840×2160 raster. The page must be
    // in A4-landscape point territory, NOT 3840pt wide.
    const { pageWidth, pageHeight } = computePdfPageSize(3840, 2160);
    expect(pageWidth).toBeLessThanOrEqual(842 + 1);
    expect(pageHeight).toBeLessThanOrEqual(595 + 1);

    const portrait = computePdfPageSize(1080, 3840);
    expect(portrait.pageWidth).toBeLessThanOrEqual(595 + 1);
    expect(portrait.pageHeight).toBeLessThanOrEqual(842 + 1);
  });

  it('accepts explicit page geometry (used when callers precompute layout)', () => {
    const pdf = buildPdfFromJpeg(fakeJpeg(64), 800, 600, { pageWidth: 500, pageHeight: 400 });
    const latin1 = new TextDecoder('latin1').decode(pdf);
    expect(latin1).toContain('/MediaBox [0 0 500.00 400.00]');
  });
});

describe('capResolution', () => {
  it('returns unchanged dimensions under the cap', () => {
    expect(capResolution(1920, 1080)).toEqual({ width: 1920, height: 1080, scale: 1 });
  });

  it('scales down over-cap rasters to ≤40MP', () => {
    const capped = capResolution(9500, 5000, MAX_EXPORT_PIXELS);
    expect(capped.width * capped.height).toBeLessThanOrEqual(MAX_EXPORT_PIXELS);
    expect(capped.scale).toBeLessThan(1);
  });
});

describe('sanitizeCssValue', () => {
  it('passes plain values through', () => {
    expect(sanitizeCssValue('#ef4444')).toBe('#ef4444');
    expect(sanitizeCssValue('12px solid rgb(0,0,0)')).toBe('12px solid rgb(0,0,0)');
  });

  it('keeps data: and same-origin url() values', () => {
    expect(sanitizeCssValue('url("data:image/png;base64,AAAA")', ['https://app.example.com'])).toContain('data:');
    expect(sanitizeCssValue('url(https://app.example.com/img.png)', ['https://app.example.com'])).toContain('app.example.com');
    expect(sanitizeCssValue('url(/local/asset.svg)')).toContain('/local/asset.svg');
  });

  it('DROPS third-party url() values (CSP-restricted)', () => {
    expect(sanitizeCssValue('url(https://evil.example.com/x.png)', ['https://app.example.com'])).toBe('');
    expect(sanitizeCssValue('url(https://evil.example.com/x.png)')).toBe('');
  });

  it('drops the whole declaration when ANY url() token is foreign', () => {
    expect(
      sanitizeCssValue('url(/ok.png), url(https://evil.example.com/x.png)', []),
    ).toBe('');
  });
});
