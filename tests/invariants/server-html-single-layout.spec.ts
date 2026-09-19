/**
 * Platform-wide invariant — FE-MEDIUM-093:
 *
 * A NestJS service may not build its own HTML document.
 *
 * # Why
 *
 * Three services each hand-built the same 600-pixel e-mail card — notification
 * (6 templates plus the two auth handlers), admin-api (5 seeded templates),
 * alert-engine and the SCADA runtime's alarm mail — with their own `<style>`
 * block and their own palette. The brand blue was `#0066cc` in one and
 * `#3B82F6` in another, danger `#dc3545` beside `#DC2626`, the footer grey
 * `#666` beside `#6b7280`. These are the surfaces a customer sees first: the
 * invitation, the password reset, the alarm that wakes someone at night, and
 * they did not look like the product or like each other.
 *
 * Worse than the drift: every one of those builders interpolated its values
 * straight into markup, so a first name or an alarm rule name carrying `<` ended
 * up as markup in an outbound mail.
 *
 * `libs/shared-contracts/src/design/email-layout.ts` now owns the shell — the
 * doctype, the head, the inlined stylesheet, the header band, the content well
 * and the footer — and the blocks the services compose it from. It paints from
 * `design/color-tokens.ts`, the same bytes `web/shared-ui` mirrors into
 * `theme.css`, and it escapes every interpolated value. A service supplies text
 * and structure, never markup and never a colour.
 *
 * This guard closes the loop: a new document opener in server-side source is a
 * failing build, so the next e-mail cannot grow a private shell, and a file that
 * emits markup cannot carry a hex colour.
 *
 * Print documents under `web/` (the HR roster, the two farm report exports, the
 * FUXA `srcdoc` frame) are whole documents by design and are out of this rule's
 * scope; they are held at zero raw hex by the rawHex dimension of
 * `tests/invariants/web-design-system-ratchet.spec.ts`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** The one module allowed to write a document opener. */
const LAYOUT_MODULE = 'libs/shared-contracts/src/design/email-layout.ts';

/** The modules that declare the colours; everything else reads them. */
const TOKEN_MODULES = new Set([
  'libs/shared-contracts/src/design/color-tokens.ts',
  'libs/shared-contracts/src/design/email-layout.ts',
  'libs/shared-contracts/src/design/severity.ts',
]);

/**
 * The one file that keeps its own colours, and why.
 *
 * `libs/node-components` is a PUBLISHED, buildable package: its output is the
 * UMD bundle `sens-api-gateway/static/aquaculture-nodes.umd.js`, checked in and
 * embedded in the Rust binary with `include_bytes!`. Nx's boundary rule refuses
 * a buildable library importing the source-only token lib, and with no gate
 * rebuilding that bundle, a source change would leave the edge panel drawing
 * the previous colours. Its nine values are also ISA-5.1 P&ID line conventions
 * — process black, electrical red, pneumatic blue, hydraulic green, instrument
 * orange, data violet, capillary grey, steam orange, drain cyan — which a
 * plant engineer reads, not brand choices.
 *
 * Tracked under FE-MEDIUM-093: closing it needs the bundle regenerated from
 * source by a gate, not another import.
 */
const PUBLISHED_BUNDLE_SOURCES = new Set(['libs/node-components/src/config/connectionTypes.ts']);

/** Server-side source: the trees that must not carry a private e-mail shell. */
const SCANNED_TREES = ['apps', 'libs', 'platform'];

/**
 * A document being emitted, not a sanitiser's pattern: the opener must close
 * with a literal `>` and carry no regex metacharacters, so
 * `/<style[^>]*>/` and `/<style\b[^<]*…/` — which strip markup rather than
 * write it — are correctly left alone.
 */
const DOCUMENT_OPENER = /<!\s*DOCTYPE\s+html\s*>|<(?:html|body|style)(?:\s+[^<>]*)?>/gi;

/** Every CSS spelling of a hex colour, the same reading as the web ratchet. */
const RAW_HEX = /(?<![\w&#$])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;

/** Markup being written: an element with a literal `>`, again not a pattern. */
const MARKUP_TAG =
  /<(?:div|p|span|table|tr|td|th|h1|h2|h3|h4|a|ul|ol|li|strong|em|img|br|hr)(?:\s+[^<>]*)?>/gi;

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /\/\/[^\n]*/g;

function serverSourceFiles(): string[] {
  const listed = execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', ...SCANNED_TREES.map((t) => `${t}/**/*.ts`)],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ).split('\n');

  return listed.filter(
    (f) =>
      f.length > 0 &&
      !f.endsWith('.spec.ts') &&
      !f.endsWith('.e2e-spec.ts') &&
      !f.endsWith('.d.ts') &&
      !f.includes('/__tests__/') &&
      !f.includes('/test/') &&
      !f.includes('/migrations/'),
  );
}

/** Comments describe the markup a module writes; only code counts. */
function codeOf(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8')
    .replace(BLOCK_COMMENT, '')
    .replace(LINE_COMMENT, '');
}

function countOf(source: string, pattern: RegExp): number {
  return source.match(new RegExp(pattern.source, pattern.flags))?.length ?? 0;
}

describe('INVARIANT (FE-MEDIUM-093): one HTML layout for every server-rendered document', () => {
  const files = serverSourceFiles();

  it('scans the server-side source trees', () => {
    // A path change that empties the scan would make every test below vacuous.
    expect(files.length).toBeGreaterThan(2000);
    expect(files).toContain(LAYOUT_MODULE);
  });

  it('only the layout module opens an HTML document', () => {
    const offenders: string[] = [];

    for (const rel of files) {
      if (rel === LAYOUT_MODULE) continue;
      const openers = countOf(codeOf(rel), DOCUMENT_OPENER);
      if (openers > 0) offenders.push(`${rel} (${openers})`);
    }

    if (offenders.length > 0) {
      throw new Error(
        `A service may not build its own HTML document — that is how five\n` +
          `private e-mail palettes grew (FE-MEDIUM-093). Compose the document\n` +
          `with renderEmail() and the blocks from ${LAYOUT_MODULE}:\n` +
          `it owns the shell, paints from the design tokens and escapes every\n` +
          `interpolated value. Offenders:\n` +
          offenders.map((o) => `  ${o}`).join('\n'),
      );
    }
  });

  it('no server-side file writes a colour of its own', () => {
    const offenders: string[] = [];

    for (const rel of files) {
      if (TOKEN_MODULES.has(rel) || PUBLISHED_BUNDLE_SOURCES.has(rel)) continue;
      const hexes = countOf(codeOf(rel), RAW_HEX);
      if (hexes > 0) offenders.push(`${rel} (${hexes})`);
    }

    if (offenders.length > 0) {
      throw new Error(
        `A colour written in a service is a second palette: it is a value the\n` +
          `customer sees — a chart series, a role badge, a parameter's line, an\n` +
          `alarm band — and it stops following the product the moment the token\n` +
          `changes. Take it from \`colors\`, \`chartPalette\` or \`severityColor\`\n` +
          `in @aquaculture/shared-contracts. If it is an example inside a\n` +
          `validation message, write the shape (#rrggbb) rather than a value.\n` +
          `Offenders:\n` +
          offenders.map((o) => `  ${o}`).join('\n'),
      );
    }
  });

  it('the layout module is what the services compose through', () => {
    const layout = readFileSync(resolve(REPO_ROOT, LAYOUT_MODULE), 'utf8');

    // The shell, the escaping and the token source are the three properties the
    // rule above assumes; a refactor that drops one would leave it enforcing
    // nothing.
    expect(layout).toMatch(/export function renderEmail\(/);
    expect(layout).toMatch(/export function escapeHtml\(/);
    expect(layout).toMatch(/from '\.\/color-tokens'/);
    expect(countOf(layout.replace(BLOCK_COMMENT, ''), DOCUMENT_OPENER)).toBeGreaterThan(0);
  });

  it('reads every spelling the defect used, and no sanitiser pattern', () => {
    const emitted = [
      '<!DOCTYPE html>',
      '<!doctype html>',
      '<html lang="en">',
      '<body style="margin:0">',
      '<style>',
      '<style type="text/css">',
    ];
    for (const sample of emitted) {
      expect(countOf(sample, DOCUMENT_OPENER)).toBe(1);
    }

    const sanitisers = [
      "html.replace(/<style[^>]*>[\\s\\S]*?<\\/style>/gi, '')",
      "result.replace(/<style\\b[^<]*(?:(?!<\\/style>)<[^<]*)*<\\/style>/gi, '')",
      "src.replace(/<[^>]+>/g, ' ')",
    ];
    for (const sample of sanitisers) {
      expect(countOf(sample, DOCUMENT_OPENER)).toBe(0);
    }

    for (const sample of ['#fff', '#0066cc', '#DC2626', '#00000033']) {
      expect(countOf(sample, RAW_HEX)).toBe(1);
    }
    // A pull-request reference and an HTML entity are not colours.
    for (const sample of ['PR#363 port', 'DINT#123', '&#9888;']) {
      expect(countOf(sample, RAW_HEX)).toBe(0);
    }

    expect(countOf('<td style="padding:4px">', MARKUP_TAG)).toBe(1);
    expect(countOf('/<[^>]+>/g', MARKUP_TAG)).toBe(0);
  });
});
