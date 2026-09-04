// Tests for the pack's binary text extraction (PDF / DOCX / XLSX / PPTX).
//
// WHY: the chronology, the amounts and the version comparison are only as
// complete as the documents ARIA could read, and most of a legal archive is
// PDF and Word. These tests pin the extractor to the fixtures the generator
// writes (reproducible bytes, not opaque blobs) and to the honest refusals a
// legal record depends on: an encrypted or scanned PDF must say so, never
// yield invented text.
//
// WHAT: node:test cases over packs/legal/fixtures/binary. Run from `new-aria/`:
//   npx ts-node --project tools/gates/tsconfig.json packs/legal/adapters/binary/extract.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { extractBinaryText } from './extract';
import { decodeXmlEntities, readZipDirectory } from './ooxml';
import { loadPdfDocument } from './pdf-document';
import { parseToUnicode } from './pdf-encoding';
import { PdfLexer } from './pdf-objects';

const FIXTURES = resolve(__dirname, '..', '..', 'fixtures', 'binary');
const fixture = (name: string): Buffer => readFileSync(resolve(FIXTURES, name));

function textOf(name: string, extension: string): string {
  const outcome = extractBinaryText(extension, fixture(name));
  assert.equal(outcome.status, 'text', `${name} should yield text`);
  return outcome.status === 'text' ? outcome.text : '';
}

test('simple-font PDF: WinAnsi bytes decode to Norwegian text with dates and amounts intact', () => {
  const text = textOf('faktura_2024-001.pdf', '.pdf');
  assert.match(text, /FAKTURA nr\. 2024-001/);
  assert.match(text, /Nordlys Entreprenør AS/);
  assert.match(text, /Fakturadato: 12\.03\.2024/);
  assert.match(text, /Forfallsdato: 26\. mars 2024/);
  assert.match(text, /NOK 6 187 500,00/);
  assert.match(text, /Totalt å betale/);
});

test('multi-page Flate PDF: pages come out in page-tree order with page markers', () => {
  const outcome = extractBinaryText('.pdf', fixture('faktura_2024-001_med_vedlegg.pdf'));
  assert.equal(outcome.status, 'text');
  if (outcome.status !== 'text') return;
  assert.equal(outcome.detail, 'pdf_pages:2;with_text:2');
  assert.deepEqual(outcome.parts, ['page:1', 'page:2']);
  const first = outcome.text.indexOf('[page 1]');
  const second = outcome.text.indexOf('[page 2]');
  assert.ok(first >= 0 && second > first, 'page 1 precedes page 2');
  assert.ok(outcome.text.indexOf('Vedlegg A') > second, 'page 2 content follows its marker');
  assert.match(outcome.text, /Tilbakeholdt beløp: NOK 1 200 000,00/);
});

test('Type0 font with ToUnicode CMap and TJ kerning arrays: glyph ids map back to words with spaces', () => {
  const text = textOf('klage_2024-03-04.pdf', '.pdf');
  assert.match(text, /KLAGE PÅ LEVERANSE/);
  assert.match(text, /advokat Kari Nordmann/);
  assert.match(text, /Dato: 4\. mars 2024/);
  assert.match(text, /Krav om prisavslag: NOK 1 200 000\./);
  assert.match(text, /Svarfrist: 18\.03\.2024\./);
});

test('object streams + xref stream (PDF 1.5): the catalogue inside /ObjStm is found without the xref', () => {
  const doc = loadPdfDocument(fixture('avtale_v1_utkast.pdf'));
  assert.equal(doc.pages.length, 1);
  assert.equal(doc.encrypted, false);
  const text = textOf('avtale_v1_utkast.pdf', '.pdf');
  assert.match(text, /AVTALE om totalentreprise - versjon 1 \(utkast\)/);
  assert.match(text, /Kontraktssum: NOK 4 950 000 eks\. mva\./);
  assert.match(text, /Ferdigstillelse: 30\.06\.2024\./);
});

test('encrypted PDF is refused on the /Encrypt declaration, never decrypted or guessed', () => {
  const outcome = extractBinaryText('.pdf', fixture('forlikstilbud_kryptert.pdf'));
  assert.deepEqual(outcome, { status: 'no_text', reason: 'pdf_encrypted' });
});

test('image-only PDF (a scan) reports no text layer with its page count, not invented text', () => {
  const outcome = extractBinaryText('.pdf', fixture('skannet_kvittering.pdf'));
  assert.deepEqual(outcome, { status: 'no_text', reason: 'pdf_no_text_layer:1_pages' });
});

test('bytes without a PDF header are refused with a stated reason', () => {
  assert.deepEqual(extractBinaryText('.pdf', Buffer.from('not a pdf at all')), { status: 'no_text', reason: 'pdf_header_missing' });
});

test('DOCX: body paragraphs, tabs, table cells, tracked changes and the header are all read', () => {
  const outcome = extractBinaryText('.docx', fixture('klage_utkast_v3.docx'));
  assert.equal(outcome.status, 'text');
  if (outcome.status !== 'text') return;
  assert.deepEqual(outcome.parts, ['word/document.xml', 'word/header1.xml']);
  assert.match(outcome.text, /KLAGE PÅ LEVERANSE – UTKAST v3/);
  assert.match(outcome.text, /Dato: 6\. mars 2024/);
  assert.match(outcome.text, /avtale av 15\.01\.2024\tog faktura 2024-001\./, 'a w:tab becomes a tab character');
  assert.match(outcome.text, /Prisavslag milepæl 2\n\tNOK 1 200 000/, 'table cells are tab-separated');
  assert.match(outcome.text, /Nytt i v3: krav om dagmulkt\./, 'inserted text (w:ins) is kept');
  assert.doesNotMatch(outcome.text, /Gammel setning fjernet/, 'deleted text (w:del) is dropped');
  assert.match(outcome.text, /Sak 24-001 – konfidensielt/, 'header text is included');
});

test('XLSX: shared strings and numeric cells render as tab-separated rows', () => {
  const text = textOf('kronologi_regneark.xlsx', '.xlsx');
  assert.equal(text.split('\n')[0], 'Dato\tHendelse\tBeløp NOK');
  assert.match(text, /2024-03-04\tKlage sendt\t1200000/);
});

test('PPTX: slides come out in numeric slide order (slide2 before slide10)', () => {
  const outcome = extractBinaryText('.pptx', fixture('byggemoter.pptx'));
  assert.equal(outcome.status, 'text');
  if (outcome.status !== 'text') return;
  assert.deepEqual(outcome.parts, ['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide10.xml']);
  assert.ok(outcome.text.indexOf('04.03.2024') < outcome.text.indexOf('20.03.2024'));
});

test('unsupported binary kinds carry a stated reason instead of an empty string', () => {
  assert.deepEqual(extractBinaryText('.doc', Buffer.alloc(8)), { status: 'no_text', reason: 'word97_binary_not_supported' });
  assert.deepEqual(extractBinaryText('.jpg', Buffer.alloc(8)), { status: 'no_text', reason: 'image_no_text_layer' });
  assert.deepEqual(extractBinaryText('.xyz', Buffer.alloc(8)), { status: 'no_text', reason: 'no_text_extraction_for_extension:.xyz' });
});

test('a non-ZIP body handed to the Office readers is refused, not parsed', () => {
  assert.equal(readZipDirectory(Buffer.from('PK but not really a zip')), null);
  assert.deepEqual(extractBinaryText('.docx', Buffer.from('plain')), { status: 'no_text', reason: 'docx_package_unreadable' });
});

test('extraction is deterministic: two runs over the same bytes are byte-identical', () => {
  for (const name of ['faktura_2024-001_med_vedlegg.pdf', 'klage_2024-03-04.pdf', 'klage_utkast_v3.docx', 'kronologi_regneark.xlsx']) {
    const extension = name.slice(name.lastIndexOf('.'));
    const a = extractBinaryText(extension, fixture(name));
    const b = extractBinaryText(extension, fixture(name));
    assert.deepEqual(a, b, name);
  }
});

test('PDF lexer: literal string escapes and nested parentheses follow ISO 32000-1 §7.3.4.2', () => {
  const lexer = new PdfLexer(Buffer.from('(a\\(b\\)c (nested) \\101\\n)', 'latin1'));
  const value = lexer.parseValue(false);
  assert.ok(value !== null && value.type === 'string');
  if (value !== null && value.type === 'string') assert.equal(value.bytes.toString('latin1'), 'a(b)c (nested) A\n');
});

test('ToUnicode CMap: bfrange with a destination array and with an incrementing destination both decode', () => {
  const cmap = parseToUnicode(
    Buffer.from('1 begincodespacerange <00> <FF> endcodespacerange 2 beginbfrange <41> <43> <0061> <44> <45> [<0078> <0079>] endbfrange', 'latin1'),
  );
  assert.equal(cmap.ranges.length, 2);
  assert.equal(cmap.codespaces[0]?.byteLength, 1);
});

test('XML entity decoding covers the predefined and numeric forms', () => {
  assert.equal(decodeXmlEntities('&lt;a&gt; &amp; &quot;b&quot; &#65; &#x42;'), '<a> & "b" A B');
});
