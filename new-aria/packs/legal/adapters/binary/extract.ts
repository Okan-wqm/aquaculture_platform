// Binary document text extraction — one entry point for the inventory adapter.
//
// WHY: the adapter must give every file a truthful fate. A PDF with a text
// layer is `text`; a scanned PDF, an encrypted PDF or a Word 97 binary is
// `metadata_only` WITH THE REASON, so that the coverage record says why the
// chronology could not see inside it. The reason is what a lawyer needs to
// decide whether to OCR, request a password, or obtain the original.
//
// WHAT: `extractBinaryText(extension, bytes)` dispatches to the PDF and OOXML
// readers and normalises their outcomes into one result shape.
import { loadPdfDocument } from './pdf-document';
import { extractPageTexts } from './pdf-text';
import { extractDocxText, extractPptxText, extractXlsxText } from './ooxml';

export type BinaryTextOutcome =
  | { readonly status: 'text'; readonly text: string; readonly parts: readonly string[]; readonly detail: string }
  | { readonly status: 'no_text'; readonly reason: string };

/** Extensions this module can open. Everything else is metadata_only by design. */
export const BINARY_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['.pdf', '.docx', '.xlsx', '.pptx']);

/** Stated reasons for the extensions the pack inventories but cannot read. */
export const UNSUPPORTED_BINARY_REASONS: Readonly<Record<string, string>> = {
  '.doc': 'word97_binary_not_supported',
  '.msg': 'outlook_msg_not_supported',
  '.png': 'image_no_text_layer',
  '.jpg': 'image_no_text_layer',
  '.jpeg': 'image_no_text_layer',
  '.tif': 'image_no_text_layer',
  '.tiff': 'image_no_text_layer',
};

function extractPdf(bytes: Buffer): BinaryTextOutcome {
  if (!bytes.subarray(0, 1024).includes('%PDF', 0, 'latin1')) {
    return { status: 'no_text', reason: 'pdf_header_missing' };
  }
  let doc;
  try {
    doc = loadPdfDocument(bytes);
  } catch {
    return { status: 'no_text', reason: 'pdf_malformed' };
  }
  if (doc.encrypted) return { status: 'no_text', reason: 'pdf_encrypted' };
  if (doc.pages.length === 0) return { status: 'no_text', reason: 'pdf_no_pages' };
  let pages: string[];
  try {
    pages = extractPageTexts(doc);
  } catch {
    return { status: 'no_text', reason: 'pdf_content_unparseable' };
  }
  const nonEmpty = pages.filter((page) => page.length > 0).length;
  if (nonEmpty === 0) return { status: 'no_text', reason: `pdf_no_text_layer:${pages.length}_pages` };
  const text = pages.map((page, index) => `\f[page ${index + 1}]\n${page}`).join('\n').trim();
  return {
    status: 'text',
    text,
    parts: pages.map((_page, index) => `page:${index + 1}`),
    detail: `pdf_pages:${pages.length};with_text:${nonEmpty}`,
  };
}

function fromOoxml(result: { readonly text: string; readonly parts: readonly string[] } | null, kind: string): BinaryTextOutcome {
  if (result === null) return { status: 'no_text', reason: `${kind}_package_unreadable` };
  if (result.text.length === 0) return { status: 'no_text', reason: `${kind}_no_text` };
  return { status: 'text', text: result.text, parts: result.parts, detail: `${kind}_parts:${result.parts.length}` };
}

export function extractBinaryText(extension: string, bytes: Buffer): BinaryTextOutcome {
  switch (extension) {
    case '.pdf':
      return extractPdf(bytes);
    case '.docx':
      return fromOoxml(extractDocxText(bytes), 'docx');
    case '.xlsx':
      return fromOoxml(extractXlsxText(bytes), 'xlsx');
    case '.pptx':
      return fromOoxml(extractPptxText(bytes), 'pptx');
    default: {
      const reason = UNSUPPORTED_BINARY_REASONS[extension];
      return { status: 'no_text', reason: reason ?? `no_text_extraction_for_extension:${extension || '(none)'}` };
    }
  }
}
