/**
 * Export utilities for the SCADA builder PNG/PDF export.
 *
 * SECURITY CONVENTION (applies to every export path in this module and the
 * ExportDialog): the serialized export SVG/DOM string is ONLY ever
 *   - handed to an <img src=data:> inside a *sandboxed* iframe, or
 *   - serialized to bytes for download.
 * It is NEVER assigned to innerHTML / dangerouslySetInnerHTML / insertAdjacentHTML
 * anywhere — serialized markup is treated as untrusted input.
 *
 * Pure helpers in this file are unit-tested directly (jsdom has no canvas,
 * so the byte-embedding functions are tested with fake JPEG bytes).
 */

/* ------------------------------------------------------------------ */
/*  Resolution cap                                                     */
/* ------------------------------------------------------------------ */

/** Hard cap on output canvas megapixels (40 MP ≈ 9500×4200). */
export const MAX_EXPORT_PIXELS = 40_000_000;

export function capResolution(
  width: number,
  height: number,
  maxPixels: number = MAX_EXPORT_PIXELS,
): { width: number; height: number; scale: number } {
  const pixels = width * height;
  if (pixels <= maxPixels) return { width, height, scale: 1 };
  const scale = Math.sqrt(maxPixels / pixels);
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale,
  };
}

/* ------------------------------------------------------------------ */
/*  Computed-style inlining (allowlist)                                */
/* ------------------------------------------------------------------ */

/**
 * CSS properties copied from live computed style into the export clone.
 * Deliberately EXCLUDES anything script-relevant or exotic; the goal is
 * visual fidelity for widget rendering, not a full CSS dump.
 */
export const STYLE_ALLOWLIST: readonly string[] = [
  'color', 'background-color', 'background', 'opacity',
  'font-family', 'font-size', 'font-weight', 'font-style',
  'text-align', 'text-transform', 'text-decoration', 'white-space',
  'line-height', 'letter-spacing', 'word-break',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-radius', 'border-color', 'border-width', 'border-style',
  'box-shadow', 'outline', 'outline-offset',
  'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap',
  'display', 'visibility', 'overflow', 'object-fit',
  'flex-direction', 'flex-wrap', 'justify-content', 'align-items',
  'align-self', 'justify-self', 'gap', 'grid-template-columns', 'grid-template-rows',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'margin', 'padding', 'position', 'top', 'left', 'right', 'bottom',
  'transform', 'transform-origin', 'z-index', 'vertical-align', 'list-style',
];

const STYLE_ALLOWLIST_SET = new Set(STYLE_ALLOWLIST);

/**
 * url() values are dropped unless they match the allowed origins (data:
 * URLs and same-origin resources pass; everything else — third-party
 * images/fonts that a restrictive CSP would block anyway — is stripped).
 */
export function sanitizeCssValue(value: string, allowedOrigins: string[] = []): string {
  if (!value.includes('url(')) return value;

  // Check every url(...) token; drop the declaration when any token is not allowed
  const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  let match: RegExpExecArray | null;
  for (urlRegex.lastIndex = 0; (match = urlRegex.exec(value)) !== null;) {
    const url = match[2].trim();
    const allowed =
      url.startsWith('data:') ||
      allowedOrigins.some((origin) => url.startsWith(origin)) ||
      url.startsWith('/');
    if (!allowed) return '';
  }
  return value;
}

/**
 * Walk the live subtree and the cloned subtree in parallel, inlining the
 * ALLOWLISTED computed styles into each clone element's style attribute.
 * Anything not on the allowlist (and any url() the CSP would not permit)
 * is simply not carried over.
 */
export function inlineComputedStylesIntoClone(
  liveRoot: Element,
  cloneRoot: Element,
  allowedOrigins: string[] = [],
): void {
  const liveWalker = document.createTreeWalker(liveRoot, NodeFilter.SHOW_ELEMENT);
  const cloneWalker = document.createTreeWalker(cloneRoot, NodeFilter.SHOW_ELEMENT);

  let liveNode = liveWalker.nextNode() as Element | null;
  let cloneNode = cloneWalker.nextNode() as Element | null;
  while (liveNode && cloneNode) {
    const computed = window.getComputedStyle(liveNode);
    const style = (cloneNode as HTMLElement).style;
    if (style) {
      for (const prop of STYLE_ALLOWLIST_SET) {
        const value = computed.getPropertyValue(prop);
        if (!value) continue;
        const sanitized = sanitizeCssValue(value, allowedOrigins);
        if (sanitized) {
          try {
            style.setProperty(prop, sanitized);
          } catch {
            // read-only/invalid property — skip
          }
        }
      }
    }
    liveNode = liveWalker.nextNode() as Element | null;
    cloneNode = cloneWalker.nextNode() as Element | null;
  }
}

/* ------------------------------------------------------------------ */
/*  Minimal PDF writer (JPEG XObject via /DCTDecode)                   */
/* ------------------------------------------------------------------ */

/** A4 landscape in PDF points; portrait when the image is taller than wide. */
export const A4_LANDSCAPE_PT = { width: 842, height: 595 };
export const A4_PORTRAIT_PT = { width: 595, height: 842 };

/**
 * Compute the PDF page size (in POINTS) for a raster: A4 orientation that
 * matches the image aspect, with the image scaled to fit with margins.
 * NOTE: raw pixels are NEVER used as points — a 2x 1920px export must not
 * produce a 3840pt page.
 */
export function computePdfPageSize(
  imageWidth: number,
  imageHeight: number,
): { pageWidth: number; pageHeight: number; margin: number } {
  const pageSize = imageWidth >= imageHeight ? A4_LANDSCAPE_PT : A4_PORTRAIT_PT;
  const margin = 24; // pt
  const availW = pageSize.width - margin * 2;
  const availH = pageSize.height - margin * 2;
  const scale = Math.min(availW / imageWidth, availH / imageHeight);
  return {
    pageWidth: Math.round(imageWidth * scale) + margin * 2,
    pageHeight: Math.round(imageHeight * scale) + margin * 2,
    margin,
  };
}

/**
 * Build a minimal PDF 1.4 binary wrapping a single JPEG image.
 *
 * The JPEG bytes are embedded as an image XObject with `/Filter /DCTDecode`
 * — the standard lossy-DCT filter every PDF reader decodes natively. This
 * replaces the previous approach of dumping raw PNG bytes with
 * `/FlateDecode` (a lie about the stream encoding that many readers
 * rejected).
 *
 * Page geometry is in POINTS scaled to fit (see computePdfPageSize).
 */
export function buildPdfFromJpeg(
  jpegBytes: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  pageOpts?: { pageWidth?: number; pageHeight?: number; margin?: number },
): Uint8Array {
  const encoder = new TextEncoder();

  const size = pageOpts?.pageWidth != null && pageOpts?.pageHeight != null
    ? { pageWidth: pageOpts.pageWidth, pageHeight: pageOpts.pageHeight, margin: pageOpts.margin ?? 24 }
    : computePdfPageSize(imageWidth, imageHeight);
  const { pageWidth, pageHeight, margin } = size;

  // Image drawn to fit inside the page box (points)
  const availW = pageWidth - margin * 2;
  const availH = pageHeight - margin * 2;
  const scale = Math.min(availW / imageWidth, availH / imageHeight);
  const drawW = imageWidth * scale;
  const drawH = imageHeight * scale;
  const offsetX = (pageWidth - drawW) / 2;
  const offsetY = (pageHeight - drawH) / 2;

  // Object offsets tracked for the xref table
  const offsets: number[] = [];
  const parts: Uint8Array[] = [];
  let pos = 0;

  function write(str: string): void {
    const bytes = encoder.encode(str);
    parts.push(bytes);
    pos += bytes.length;
  }

  function writeRaw(bytes: Uint8Array): void {
    parts.push(bytes);
    pos += bytes.length;
  }

  function markObj(): void {
    offsets.push(pos);
  }

  // Header
  write('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  // Obj 1: Catalog
  markObj();
  write('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // Obj 2: Pages
  markObj();
  write('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  // Obj 3: Page (points, not pixels)
  markObj();
  write(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(2)}] ` +
      `/Contents 4 0 R /Resources << /XObject << /Img0 5 0 R >> >> >>\nendobj\n`,
  );

  // Obj 4: Content stream — centre the image on the page
  const contentStr =
    `q\n${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${offsetX.toFixed(2)} ${offsetY.toFixed(2)} cm\n/Img0 Do\nQ\n`;
  markObj();
  write(`4 0 obj\n<< /Length ${contentStr.length} >>\nstream\n`);
  write(contentStr);
  write('\nendstream\nendobj\n');

  // Obj 5: Image XObject — JPEG via DCTDecode (the bytes stay untouched)
  markObj();
  write(
    `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
      `/Length ${jpegBytes.length} /Filter /DCTDecode >>\nstream\n`,
  );
  writeRaw(jpegBytes);
  write('\nendstream\nendobj\n');

  // Cross-reference table
  const xrefPos = pos;
  write('xref\n');
  write(`0 ${offsets.length + 1}\n`);
  write('0000000000 65535 f \n');
  for (const offset of offsets) {
    write(`${String(offset).padStart(10, '0')} 00000 n \n`);
  }

  // Trailer
  write('trailer\n');
  write(`<< /Size ${offsets.length + 1} /Root 1 0 R >>\n`);
  write('startxref\n');
  write(`${xrefPos}\n`);
  write('%%EOF\n');

  // Merge all parts into a single Uint8Array
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let cursor = 0;
  for (const part of parts) {
    result.set(part, cursor);
    cursor += part.length;
  }

  return result;
}

/**
 * Validation helper (used by tests and defensive runtime checks): does the
 * produced PDF declare a parseable xref and embed the JPEG SOI bytes?
 */
export function pdfDiagnostics(pdf: Uint8Array): {
  hasSoiMarker: boolean;
  xrefOffsets: number[];
  headerOk: boolean;
} {
  const text = new TextDecoder('latin1').decode(pdf);
  const headerOk = text.startsWith('%PDF-1.4');
  const hasSoiMarker = pdf.findIndex((b, i) => b === 0xff && pdf[i + 1] === 0xd8) !== -1;

  const xrefOffsets: number[] = [];
  const xrefMatch = text.match(/startxref\n(\d+)\n%%EOF/);
  if (xrefMatch) {
    const xrefPos = Number(xrefMatch[1]);
    const xrefSection = text.slice(xrefPos);
    const entryRegex = /(\d{10}) 00000 n /g;
    let m: RegExpExecArray | null;
    while ((m = entryRegex.exec(xrefSection)) !== null) {
      xrefOffsets.push(Number(m[1]));
    }
  }
  return { hasSoiMarker, xrefOffsets, headerOk };
}
