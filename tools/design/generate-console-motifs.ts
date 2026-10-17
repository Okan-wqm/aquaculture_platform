/**
 * Writes the console's workspace motifs into suderra.css as data URIs
 * (FE-MEDIUM-348).
 *
 * WHAT: the three drawings the tenant console shows behind its pages —
 * Production's reef fish, derived here from the login scene's art, and the
 * Greenhouse and Control & sensors line drawings, hand-drawn in
 * `web/shared-ui/src/styles/motifs/` — as custom properties of the motif
 * layer (`.sd-content::after` in suderra.css), between BEGIN/END GENERATED
 * sentinels: `--sd-motif-<ws>` is the drawing as a `data:image/svg+xml` URI
 * and `--sd-motif-<ws>-size` its tile. Each workspace rule masks with the
 * pair. The layer paints the workspace accent through the mask at the
 * theme's motif opacity, so a drawing carries no colour: a mask reads
 * coverage only.
 *
 * WHY inlined: the drawings were files the stylesheet named with
 * `url('./motifs/*.svg')`. The shell's entry stylesheet `@import`s suderra.css
 * from shared-ui; Tailwind inlines it, Vite then resolved the `url()` against
 * the shell's own styles directory, found nothing and left it as written, and
 * production requested `/assets/motifs/*.svg`, which nginx 404s — the mask
 * stayed transparent. A data URI has no path to resolve: the drawing travels
 * inside whichever stylesheet imports suderra.css, and the CSP allows
 * `img-src data:`. The unresolved-`url()` warning now fails the build
 * (web/shared-ui/src/federation/unresolvedAssetUrlGate.ts).
 *
 * WHY Production's drawing is generated rather than drawn: the fish are
 * drawn once, in `web/shell/src/components/reef/art/*.svg`, for the login
 * scene. A hand-copied silhouette would be a second drawing that drifts the
 * first time an artist touches a fish; derived, the console's reef is the
 * login's reef. Every filled shape of a fish keeps its geometry and drops its
 * paint.
 *
 * `tests/invariants/web-console-motif-generated.spec.ts` regenerates and
 * diffs the block, so a hand edit, an edited source or a stale block fails the
 * build.
 *
 *   npx tsx tools/design/generate-console-motifs.ts [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

export const REEF_ART_DIR = 'web/shell/src/components/reef/art';
/** The hand-drawn motifs: the generator's sources, which no stylesheet names. */
export const MOTIF_SOURCE_DIR = 'web/shared-ui/src/styles/motifs';
export const SUDERRA_CSS_PATH = 'web/shared-ui/src/styles/suderra.css';

/** The workspaces that draw a motif; Company keeps the plain engineering grid. */
export const MOTIF_WORKSPACES = ['aqua', 'gh', 'ctl'] as const;
export type MotifWorkspace = (typeof MOTIF_WORKSPACES)[number];

/** The block sits among the motif layer's declarations, inside `@layer components`. */
const INDENT = '    ';
export const MOTIF_BLOCK_BEGIN = `${INDENT}/* BEGIN GENERATED MOTIFS (tools/design/generate-console-motifs.ts) */`;
export const MOTIF_BLOCK_END = `${INDENT}/* END GENERATED MOTIFS */`;

/** The reef's species, the baitfish school included — every one appears in the tile. */
export const MOTIF_SPECIES = [
  'salmon',
  'bass',
  'bream',
  'trout',
  'mackerel',
  'turbot',
  'tuna',
  'bait',
] as const;
type Species = (typeof MOTIF_SPECIES)[number];

/** The tile, in px; the layer repeats it at this size (`--sd-motif-aqua-size`). */
const TILE = { width: 1200, height: 800 } as const;

/** The login scene's depth planes as coverage: a far fish is fainter, as it is there. */
const DEPTH = { far: 0.45, mid: 0.7, near: 1 } as const;
type Depth = keyof typeof DEPTH;

interface Placement {
  readonly species: Species;
  /** Top-left corner of the fish's box in the tile, and its width (the height follows the art). */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  /** The art faces right; `left` mirrors it. */
  readonly facing: 'left' | 'right';
  readonly depth: Depth;
}

/**
 * Where each fish swims in the tile. Every box stays inside the tile, so the
 * repeat never cuts a fish at a seam; the bottom-dwelling turbot keeps to the
 * floor of the tile as it keeps to the floor of the login scene.
 */
const FISH: readonly Placement[] = [
  { species: 'salmon', x: 70, y: 110, width: 200, facing: 'right', depth: 'near' },
  { species: 'bass', x: 470, y: 70, width: 120, facing: 'left', depth: 'far' },
  { species: 'bream', x: 930, y: 120, width: 120, facing: 'left', depth: 'mid' },
  { species: 'mackerel', x: 560, y: 330, width: 160, facing: 'right', depth: 'mid' },
  { species: 'trout', x: 150, y: 400, width: 170, facing: 'left', depth: 'mid' },
  { species: 'bream', x: 1030, y: 420, width: 84, facing: 'right', depth: 'far' },
  { species: 'tuna', x: 790, y: 590, width: 240, facing: 'left', depth: 'near' },
  { species: 'salmon', x: 400, y: 600, width: 130, facing: 'left', depth: 'far' },
  { species: 'turbot', x: 90, y: 660, width: 124, facing: 'right', depth: 'far' },
];

/**
 * The baitfish school: eleven fish on a golden-angle spiral round one
 * anchor, so the cluster reads as a school without a random generator (the
 * output must be the same on every run).
 */
function school(anchorX: number, anchorY: number): Placement[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: 11 }, (_, i): Placement => {
    const radius = 15 * Math.sqrt(i + 0.5);
    return {
      species: 'bait',
      x: Math.round(anchorX + 2.4 * radius * Math.cos(i * golden)),
      y: Math.round(anchorY + radius * Math.sin(i * golden)),
      width: [30, 26, 34][i % 3] ?? 30,
      facing: 'right',
      depth: 'far',
    };
  });
}

const PLACEMENTS: readonly Placement[] = [...FISH, ...school(760, 210)];

export interface Silhouette {
  /** The art's viewBox size. */
  readonly width: number;
  readonly height: number;
  /** Every filled shape, geometry only. */
  readonly shapes: readonly string[];
}

const SHAPE = /<(path|ellipse|circle)\b([^>]*?)\/?>/g;
const GEOMETRY = ['d', 'cx', 'cy', 'r', 'rx', 'ry', 'transform'] as const;

function attribute(attrs: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];
}

/**
 * One fish's coverage: its filled shapes without their paint. A stroke-only
 * shape (a lateral line, a scale highlight) adds no area and is dropped; the
 * gradients in `<defs>` are paint and go with it.
 */
export function silhouette(svg: string): Silhouette {
  const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (viewBox?.[1] === undefined || viewBox[2] === undefined)
    throw new Error('reef art without a `viewBox="0 0 w h"`');
  const shapes: string[] = [];
  for (const [, tag, attrs = ''] of svg.replace(/<defs>[\s\S]*?<\/defs>/g, '').matchAll(SHAPE)) {
    const fill = attribute(attrs, 'fill');
    if (fill === 'none' || (fill === undefined && attribute(attrs, 'stroke') !== undefined))
      continue;
    const geometry = GEOMETRY.map((name) => {
      const value = attribute(attrs, name);
      return value === undefined ? '' : ` ${name}="${value}"`;
    }).join('');
    shapes.push(`<${tag}${geometry}/>`);
  }
  return { width: Number(viewBox[1]), height: Number(viewBox[2]), shapes };
}

/** Two decimals at most, no trailing zeros: the tile stays small and diffs stay readable. */
function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

/** Production's drawing, from the reef art (`read` is the art loader, swappable in tests). */
export function renderAquaMotif(
  read: (species: Species) => string = (species) => readRepoFile(`${REEF_ART_DIR}/${species}.svg`),
): string {
  const art = new Map(MOTIF_SPECIES.map((species) => [species, silhouette(read(species))]));
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE.width} ${TILE.height}" width="${TILE.width}" height="${TILE.height}">`,
  ];
  for (const fish of PLACEMENTS) {
    const shape = art.get(fish.species);
    if (shape === undefined) throw new Error(`no reef art for ${fish.species}`);
    const scale = fish.width / shape.width;
    const transform =
      fish.facing === 'right'
        ? `translate(${num(fish.x)} ${num(fish.y)}) scale(${num(scale)})`
        : `translate(${num(fish.x + fish.width)} ${num(fish.y)}) scale(${num(-scale)} ${num(scale)})`;
    const opacity = DEPTH[fish.depth] === 1 ? '' : ` opacity="${DEPTH[fish.depth]}"`;
    lines.push(`<g transform="${transform}"${opacity}>${shape.shapes.join('')}</g>`);
  }
  lines.push('</svg>', '');
  return lines.join('\n');
}

/** Every workspace's drawing as SVG text (`read` loads a repo file, swappable in tests). */
export function renderMotifs(
  read: (path: string) => string = readRepoFile,
): Record<MotifWorkspace, string> {
  return {
    aqua: renderAquaMotif((species) => read(`${REEF_ART_DIR}/${species}.svg`)),
    gh: read(`${MOTIF_SOURCE_DIR}/gh.svg`),
    ctl: read(`${MOTIF_SOURCE_DIR}/ctl.svg`),
  };
}

/** A drawing's tile: its `viewBox`, which its `width` and `height` must repeat. */
export function tileSize(svg: string): { width: number; height: number } {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? '';
  const viewBox = /\sviewBox="0 0 (\d+) (\d+)"/.exec(root);
  const width = /\swidth="(\d+)"/.exec(root)?.[1];
  const height = /\sheight="(\d+)"/.exec(root)?.[1];
  if (
    viewBox?.[1] === undefined ||
    viewBox[2] === undefined ||
    width !== viewBox[1] ||
    height !== viewBox[2]
  )
    throw new Error('a motif needs `viewBox="0 0 w h"` with the same `width` and `height`');
  return { width: Number(width), height: Number(height) };
}

/**
 * Characters a `data:` URL inside a double-quoted CSS string may not carry raw:
 * `%` (it starts an escape), `#` (it starts a fragment, and the browser would
 * cut the drawing there), `<` `>` (escaped by convention, as the grid's noise
 * is), braces and the backslash (CSS block and escape syntax), and anything
 * outside printable ASCII.
 */
const UNSAFE = /[%#<>{}\\]|[^\x20-\x7e]/gu;

/**
 * The drawing as a `data:image/svg+xml` URI: comments dropped, whitespace
 * collapsed, attribute quotes made single so the CSS string can be double,
 * and the unsafe characters percent-encoded.
 */
export function motifDataUri(svg: string): string {
  const compact = svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim();
  if (compact.includes("'"))
    throw new Error("a motif may not contain `'`: its quotes become the URI's single quotes");
  return `data:image/svg+xml,${compact.replace(/"/g, "'").replace(UNSAFE, (c) => encodeURIComponent(c))}`;
}

/** The generated block: each workspace's data URI and tile size. */
export function renderMotifBlock(motifs: Record<MotifWorkspace, string>): string {
  const lines = [MOTIF_BLOCK_BEGIN];
  for (const ws of MOTIF_WORKSPACES) {
    const { width, height } = tileSize(motifs[ws]);
    lines.push(`${INDENT}--sd-motif-${ws}: url("${motifDataUri(motifs[ws])}");`);
    lines.push(`${INDENT}--sd-motif-${ws}-size: ${width}px ${height}px;`);
  }
  lines.push(MOTIF_BLOCK_END);
  return lines.join('\n');
}

/** `css` with its generated block replaced by `block`. */
export function spliceMotifBlock(css: string, block: string): string {
  const begin = css.indexOf(MOTIF_BLOCK_BEGIN);
  const end = css.indexOf(MOTIF_BLOCK_END);
  if (begin === -1 || end < begin)
    throw new Error(`${SUDERRA_CSS_PATH} is missing the BEGIN/END GENERATED MOTIFS sentinels`);
  return css.slice(0, begin) + block + css.slice(end + MOTIF_BLOCK_END.length);
}

function main(): void {
  const current = readRepoFile(SUDERRA_CSS_PATH);
  const next = spliceMotifBlock(current, renderMotifBlock(renderMotifs()));
  if (process.argv.includes('--check')) {
    if (current !== next) {
      process.stderr.write(
        `${SUDERRA_CSS_PATH}'s motif block is stale — run \`npx tsx tools/design/generate-console-motifs.ts\`.\n`,
      );
      process.exit(1);
    }
    process.stdout.write('Console motifs are up to date.\n');
    return;
  }
  if (current !== next) writeFileSync(resolve(REPO_ROOT, SUDERRA_CSS_PATH), next);
  process.stdout.write(
    current === next ? 'Console motifs unchanged.\n' : `Wrote ${SUDERRA_CSS_PATH}'s motif block\n`,
  );
}

if (require.main === module) {
  main();
}
