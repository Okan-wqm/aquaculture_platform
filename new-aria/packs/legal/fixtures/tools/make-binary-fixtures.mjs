#!/usr/bin/env node
// Deterministic generator for the pack's binary fixtures (PDF / DOCX / XLSX / PPTX).
//
// WHY: the pack must prove it reads real document formats, and a test that
// reads bytes nobody can regenerate proves nothing when it breaks. This script
// writes every binary fixture from source text, byte-for-byte reproducible
// (fixed timestamps, no randomness), so a reviewer can diff the generator
// instead of trusting an opaque blob. It exercises the paths the extractor
// must handle: WinAnsi simple fonts, Flate streams, Type0 fonts with a
// ToUnicode CMap and TJ kerning arrays, object streams, an encrypted marker,
// an image-only page, and the three OOXML containers.
//
// WHAT: `node packs/legal/fixtures/tools/make-binary-fixtures.mjs [outDir]`
// (default packs/legal/fixtures/binary). Uses only node:zlib and node:fs.
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = resolve(process.argv[2] ?? 'packs/legal/fixtures/binary');
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// PDF builder
// ---------------------------------------------------------------------------
const latin1 = (text) => Buffer.from(text, 'latin1');

/** Escapes a literal string for a `(...)` PDF string in WinAnsi (latin1) bytes. */
function pdfLiteral(text) {
  return `(${text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
}

function assemblePdf(objects, trailerExtra = '', header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n') {
  const chunks = [latin1(header)];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((body, index) => {
    const num = index + 1;
    const head = latin1(`${num} 0 obj\n`);
    const tail = latin1('\nendobj\n');
    offsets.push(offset);
    chunks.push(head, body, tail);
    offset += head.length + body.length + tail.length;
  });
  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(latin1(xref));
  return Buffer.concat(chunks);
}

function streamObject(dictBody, data, flate) {
  const payload = flate ? deflateSync(data) : data;
  const filter = flate ? ' /Filter /FlateDecode' : '';
  return Buffer.concat([latin1(`<< ${dictBody} /Length ${payload.length}${filter} >>\nstream\n`), payload, latin1('\nendstream')]);
}

/** Simple-font page content: one Tj per line, WinAnsi bytes. */
function simpleContent(lines) {
  const ops = ['BT', '/F1 11 Tf', '72 770 Td', '14 TL'];
  lines.forEach((line, index) => {
    ops.push(index === 0 ? `${pdfLiteral(line)} Tj` : `T* ${pdfLiteral(line)} Tj`);
  });
  ops.push('ET');
  return latin1(ops.join('\n'));
}

const FAKTURA_LINES = [
  'FAKTURA nr. 2024-001',
  'Utstedt av: Nordlys Entreprenør AS (org.nr. 987 654 321)',
  'Til: Bergen Eiendom ASA',
  'Fakturadato: 12.03.2024',
  'Forfallsdato: 26. mars 2024',
  'Leveranse iht. avtale datert 2024-01-15, versjon 2 (signert).',
  'Beløp eks. mva: NOK 4 950 000,00',
  'Mva 25 %: kr 1 237 500,00',
  'Totalt å betale: NOK 6 187 500,00',
  'Betalingsreferanse: KID 0024001',
];

// (a) Simple font, uncompressed content — the smallest real PDF.
{
  const content = simpleContent(FAKTURA_LINES);
  const objects = [
    latin1('<< /Type /Catalog /Pages 2 0 R >>'),
    latin1('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    latin1('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'),
    latin1('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    streamObject('', content, false),
  ];
  writeFileSync(join(outDir, 'faktura_2024-001.pdf'), assemblePdf(objects));
}

// (b) Same document, Flate-compressed content and a second page — page order matters.
{
  const page2 = [
    'Vedlegg A - leveranseoversikt',
    'Milepæl 1 levert 05.02.2024, godkjent av byggeleder 08.02.2024.',
    'Milepæl 2 levert 01.03.2024, IKKE godkjent - avvik meldt 04.03.2024.',
    'Tilbakeholdt beløp: NOK 1 200 000,00',
  ];
  const objects = [
    latin1('<< /Type /Catalog /Pages 2 0 R >>'),
    latin1('<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>'),
    latin1('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'),
    latin1('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    streamObject('', simpleContent(FAKTURA_LINES), true),
    latin1('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>'),
    streamObject('', simpleContent(page2), true),
  ];
  writeFileSync(join(outDir, 'faktura_2024-001_med_vedlegg.pdf'), assemblePdf(objects));
}

// (c) Type0 font with Identity-H and a ToUnicode CMap, TJ arrays with kerning
//     gaps for spaces — the shape Word, LibreOffice and Chrome produce.
{
  const lines = [
    'KLAGE PÅ LEVERANSE',
    'Fra: Bergen Eiendom ASA v/ advokat Kari Nordmann',
    'Til: Nordlys Entreprenør AS',
    'Dato: 4. mars 2024',
    'Vi viser til avtale av 15.01.2024 og faktura 2024-001 av 12.03.2024.',
    'Milepæl 2 er mangelfull. Krav om prisavslag: NOK 1 200 000.',
    'Svarfrist: 18.03.2024. Uten svar vurderes rettslige skritt.',
  ];
  const chars = [...new Set(lines.join('').split('').filter((c) => c !== ' '))].sort();
  const gid = new Map(chars.map((c, i) => [c, i + 1]));
  const hex = (n) => n.toString(16).padStart(4, '0');
  const tjLine = (line) => {
    const words = line.split(' ');
    const parts = words.map((w) => `<${w.split('').map((c) => hex(gid.get(c))).join('')}>`);
    return `[${parts.join(' -250 ')}] TJ`;
  };
  const ops = ['BT', '/F2 11 Tf', '1 0 0 1 72 770 Tm'];
  lines.forEach((line, index) => {
    if (index > 0) ops.push(`1 0 0 1 72 ${770 - index * 14} Tm`);
    ops.push(tjLine(line));
  });
  ops.push('ET');
  const bfchars = chars.map((c) => `<${hex(gid.get(c))}> <${c.codePointAt(0).toString(16).padStart(4, '0')}>`).join('\n');
  const cmap = latin1(
    `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chars.length} beginbfchar\n${bfchars}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`,
  );
  const objects = [
    latin1('<< /Type /Catalog /Pages 2 0 R >>'),
    latin1('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    latin1('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F2 4 0 R >> >> /Contents 5 0 R >>'),
    latin1('<< /Type /Font /Subtype /Type0 /BaseFont /BCDEFG+Calibri /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>'),
    streamObject('', latin1(ops.join('\n')), true),
    latin1('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /BCDEFG+Calibri /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /DW 500 >>'),
    streamObject('', cmap, true),
    latin1('<< /Type /FontDescriptor /FontName /BCDEFG+Calibri /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>'),
  ];
  writeFileSync(join(outDir, 'klage_2024-03-04.pdf'), assemblePdf(objects, '', '%PDF-1.7\n'));
}

// (d) Object streams + cross-reference stream: the catalogue, pages and font
//     live inside a compressed /ObjStm, as modern producers write them.
{
  const inner = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'],
    [4, '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>'],
  ];
  let offsets = '';
  let body = '';
  for (const [num, text] of inner) {
    offsets += `${num} ${body.length} `;
    body += `${text}\n`;
  }
  const objStmData = latin1(offsets + '\n' + body);
  const first = Buffer.byteLength(offsets + '\n', 'latin1');
  const lines = [
    'AVTALE om totalentreprise - versjon 1 (utkast)',
    'Parter: Bergen Eiendom ASA (byggherre) og Nordlys Entreprenør AS (entreprenør)',
    'Kontraktssum: NOK 4 950 000 eks. mva.',
    'Oppstart: 15.01.2024. Ferdigstillelse: 30.06.2024.',
    'Dagmulkt: 0,15 % av kontraktssum per kalenderdag.',
  ];
  const content = streamObject('', simpleContent(lines), true);
  // Objects 5 (content) and 6 (ObjStm) are direct; 7 is the xref stream.
  const header = latin1('%PDF-1.5\n');
  const chunks = [header];
  let offset = header.length;
  const direct = [
    [5, content],
    [6, streamObject(`/Type /ObjStm /N ${inner.length} /First ${first}`, objStmData, true)],
  ];
  const directOffsets = new Map();
  for (const [num, buf] of direct) {
    const head = latin1(`${num} 0 obj\n`);
    const tail = latin1('\nendobj\n');
    directOffsets.set(num, offset);
    chunks.push(head, buf, tail);
    offset += head.length + buf.length + tail.length;
  }
  // xref stream rows: type(1) field2(4) field3(2); type 2 = in object stream.
  const rows = [];
  const row = (t, a, b) => {
    const r = Buffer.alloc(7);
    r[0] = t;
    r.writeUInt32BE(a, 1);
    r.writeUInt16BE(b, 5);
    rows.push(r);
  };
  row(0, 0, 65535);
  inner.forEach(([num], index) => row(2, 6, index)); // objects 1-4 in ObjStm 6
  row(1, directOffsets.get(5), 0);
  row(1, directOffsets.get(6), 0);
  const xrefOffset = offset;
  row(1, xrefOffset, 0);
  const xrefStream = streamObject('/Type /XRef /Size 8 /W [1 4 2] /Root 1 0 R', Buffer.concat(rows), true);
  chunks.push(latin1('7 0 obj\n'), xrefStream, latin1(`\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`));
  writeFileSync(join(outDir, 'avtale_v1_utkast.pdf'), Buffer.concat(chunks));
}

// (e) Encrypted marker: the trailer names /Encrypt. Bytes are not actually
//     encrypted; the extractor must refuse on the declaration alone.
{
  const objects = [
    latin1('<< /Type /Catalog /Pages 2 0 R >>'),
    latin1('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    latin1('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'),
    latin1('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    streamObject('', simpleContent(['Konfidensielt forlikstilbud']), false),
    latin1('<< /Filter /Standard /V 2 /R 3 /Length 128 /P -3904 /O <00> /U <00> >>'),
  ];
  writeFileSync(join(outDir, 'forlikstilbud_kryptert.pdf'), assemblePdf(objects, '/Encrypt 6 0 R /ID [<01><01>] '));
}

// (f) Image-only page (a scan): one XObject image, no text operators.
{
  const image = Buffer.alloc(16, 0xff);
  const objects = [
    latin1('<< /Type /Catalog /Pages 2 0 R >>'),
    latin1('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    latin1('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>'),
    streamObject('/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceGray /BitsPerComponent 8', image, false),
    streamObject('', latin1('q 595 0 0 842 0 0 cm /Im1 Do Q'), false),
  ];
  writeFileSync(join(outDir, 'skannet_kvittering.pdf'), assemblePdf(objects));
}

// ---------------------------------------------------------------------------
// ZIP / OOXML builder
// ---------------------------------------------------------------------------
function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  // DOS date/time fixed at 2024-04-01 00:00:00 for reproducibility.
  const dosTime = 0;
  const dosDate = ((2024 - 1980) << 9) | (4 << 5) | 1;
  for (const [name, text] of entries) {
    const data = Buffer.from(text, 'utf8');
    const compressed = deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, nameBuf, compressed);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const para = (text) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;

{
  const body = [
    para('KLAGE PÅ LEVERANSE – UTKAST v3'),
    para('Fra: Bergen Eiendom ASA v/ advokat Kari Nordmann'),
    para('Til: Nordlys Entreprenør AS'),
    para('Dato: 6. mars 2024'),
    `<w:p><w:r><w:t>Vi viser til avtale av 15.01.2024</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>og faktura 2024-001.</w:t></w:r></w:p>`,
    '<w:tbl><w:tr><w:tc>' + para('Post') + '</w:tc><w:tc>' + para('Beløp') + '</w:tc></w:tr>' +
      '<w:tr><w:tc>' + para('Prisavslag milepæl 2') + '</w:tc><w:tc>' + para('NOK 1 200 000') + '</w:tc></w:tr>' +
      '<w:tr><w:tc>' + para('Dagmulkt 01.03.2024–31.03.2024') + '</w:tc><w:tc>' + para('NOK 230 175') + '</w:tc></w:tr></w:tbl>',
    para('Svarfrist: 20.03.2024.'),
    `<w:p><w:ins w:author="KN" w:date="2024-03-06T10:00:00Z"><w:r><w:t>Nytt i v3: krav om dagmulkt.</w:t></w:r></w:ins><w:del w:author="KN" w:date="2024-03-06T10:00:00Z"><w:r><w:delText>Gammel setning fjernet.</w:delText></w:r></w:del></w:p>`,
  ].join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`;
  const header = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${para('Sak 24-001 – konfidensielt')}</w:hdr>`;
  const docx = zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', document],
    ['word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>'],
    ['word/header1.xml', header],
  ]);
  writeFileSync(join(outDir, 'klage_utkast_v3.docx'), docx);
}

{
  const strings = ['Dato', 'Hendelse', 'Beløp NOK', '2024-01-15', 'Avtale signert', '2024-03-04', 'Klage sendt', '2024-03-12', 'Faktura mottatt'];
  const si = strings.map((s) => `<si><t>${xmlEscape(s)}</t></si>`).join('');
  const shared = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${si}</sst>`;
  const c = (ref, idx) => `<c r="${ref}" t="s"><v>${idx}</v></c>`;
  const n = (ref, value) => `<c r="${ref}"><v>${value}</v></c>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${c('A1', 0)}${c('B1', 1)}${c('C1', 2)}</row><row r="2">${c('A2', 3)}${c('B2', 4)}${n('C2', 4950000)}</row><row r="3">${c('A3', 5)}${c('B3', 6)}${n('C3', 1200000)}</row><row r="4">${c('A4', 7)}${c('B4', 8)}${n('C4', 6187500)}</row></sheetData></worksheet>`;
  const xlsx = zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Kronologi" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>'],
    ['xl/sharedStrings.xml', shared],
    ['xl/worksheets/sheet1.xml', sheet],
  ]);
  writeFileSync(join(outDir, 'kronologi_regneark.xlsx'), xlsx);
}

{
  const slide = (lines) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${lines.map((l) => `<p:sp><p:txBody><a:p><a:r><a:t>${xmlEscape(l)}</a:t></a:r></a:p></p:txBody></p:sp>`).join('')}</p:spTree></p:cSld></p:sld>`;
  const pptx = zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'],
    ['ppt/slides/slide1.xml', slide(['Byggemøte 08.02.2024', 'Milepæl 1 godkjent'])],
    ['ppt/slides/slide2.xml', slide(['Byggemøte 04.03.2024', 'Avvik milepæl 2 – tilbakehold NOK 1 200 000'])],
    ['ppt/slides/slide10.xml', slide(['Oppsummering 20.03.2024'])],
  ]);
  writeFileSync(join(outDir, 'byggemoter.pptx'), pptx);
}

// The synthetic case archive carries four of these so the inventory adapter's
// golden run proves both the readable and the honestly-refused outcomes.
const archiveDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'case-synthetic', 'vedlegg');
mkdirSync(archiveDir, { recursive: true });
for (const [source, target] of [
  ['faktura_2024-001_med_vedlegg.pdf', 'faktura_2024-001.pdf'],
  ['klage_utkast_v3.docx', 'klage_utkast.docx'],
  ['skannet_kvittering.pdf', 'skannet_kvittering.pdf'],
  ['forlikstilbud_kryptert.pdf', 'forlikstilbud_kryptert.pdf'],
]) {
  copyFileSync(join(outDir, source), join(archiveDir, target));
}

console.log(`binary fixtures written to ${outDir} and ${archiveDir}`);
