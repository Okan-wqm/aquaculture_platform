// Minimal, HTML-free markdown block parser for the daily reports.
//
// WHY: reports are kernel-written text; the console must display them without
// ever interpreting HTML (no innerHTML, no third-party renderer). We only
// recover block structure — headings, lists, code fences, quotes, tables, rules,
// paragraphs — and hand the raw text of each block to React, which escapes it.
// Inline syntax (**bold**, [links]) is shown verbatim on purpose.

export type MarkdownBlock =
  | { readonly type: 'heading'; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly text: string }
  | { readonly type: 'paragraph'; readonly text: string }
  | { readonly type: 'list'; readonly ordered: boolean; readonly items: ReadonlyArray<string> }
  | { readonly type: 'code'; readonly language: string | null; readonly text: string }
  | { readonly type: 'quote'; readonly text: string }
  | { readonly type: 'rule' }
  | { readonly type: 'table'; readonly rows: ReadonlyArray<ReadonlyArray<string>> };

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const UNORDERED = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function toHeadingLevel(hashes: string): 1 | 2 | 3 | 4 | 5 | 6 {
  switch (hashes.length) {
    case 1:
      return 1;
    case 2:
      return 2;
    case 3:
      return 3;
    case 4:
      return 4;
    case 5:
      return 5;
    default:
      return 6;
  }
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (list !== null) {
      blocks.push({ type: 'list', ordered: list.ordered, items: list.items });
      list = null;
    }
  };
  const flushQuote = (): void => {
    if (quote.length > 0) {
      blocks.push({ type: 'quote', text: quote.join('\n') });
      quote = [];
    }
  };
  const flushAll = (): void => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';

    const fence = FENCE.exec(line);
    if (fence !== null) {
      flushAll();
      const marker = fence[1] ?? '```';
      const language = fence[2] === undefined || fence[2] === '' ? null : fence[2];
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const current = lines[index] ?? '';
        if (current.trim().startsWith(marker.charAt(0).repeat(3)) && current.trim().replace(/[`~]/g, '') === '') {
          break;
        }
        body.push(current);
        index += 1;
      }
      blocks.push({ type: 'code', language, text: body.join('\n') });
      index += 1;
      continue;
    }

    if (line.trim() === '') {
      flushAll();
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      flushAll();
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      flushAll();
      blocks.push({ type: 'heading', level: toHeadingLevel(heading[1] ?? '#'), text: heading[2] ?? '' });
      index += 1;
      continue;
    }

    if (line.trim().startsWith('|') && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1] ?? '')) {
      flushAll();
      const rows: string[][] = [splitTableRow(line)];
      index += 2;
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('|')) {
        rows.push(splitTableRow(lines[index] ?? ''));
        index += 1;
      }
      blocks.push({ type: 'table', rows });
      continue;
    }

    if (line.trim().startsWith('>')) {
      flushParagraph();
      flushList();
      quote.push(line.replace(/^\s*>\s?/, ''));
      index += 1;
      continue;
    }

    const unordered = UNORDERED.exec(line);
    const ordered = unordered === null ? ORDERED.exec(line) : null;
    if (unordered !== null || ordered !== null) {
      flushParagraph();
      flushQuote();
      const isOrdered = ordered !== null;
      const item = (unordered?.[1] ?? ordered?.[1] ?? '').trim();
      if (list === null || list.ordered !== isOrdered) {
        flushList();
        list = { ordered: isOrdered, items: [] };
      }
      list.items.push(item);
      index += 1;
      continue;
    }

    if (list !== null && /^\s{2,}\S/.test(line)) {
      // Continuation line of the previous list item.
      const last = list.items.length - 1;
      const previous = list.items[last];
      if (previous !== undefined) {
        list.items[last] = `${previous} ${line.trim()}`;
      }
      index += 1;
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line.trim());
    index += 1;
  }
  flushAll();
  return blocks;
}
